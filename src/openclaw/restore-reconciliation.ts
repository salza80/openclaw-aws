import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { parse as parseDotenv } from 'dotenv';
import type { SSMClient } from '@aws-sdk/client-ssm';
import {
  object,
  parseMembers,
  type BackupCaptureJob,
  type CapturedBackup,
} from './backup-contract.js';
import { importRestoreProviderSecrets, type RestoreSecretOwner } from './restore-secrets.js';
import { holdRestoredSessions } from './restore-session-hold.js';

type ConfigSdk = typeof import('openclaw/plugin-sdk/config-mutation');
type NativeConfig = NonNullable<Parameters<ConfigSdk['replaceConfigFile']>[0]['sourceConfig']>;

export function restoredEnvironmentText(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error('Restored environment contains unsupported variable names');
      for (const quoted of [JSON.stringify(value), `'${value}'`, `\`${value}\``, `"${value}"`]) {
        const line = `${name}=${quoted}\n`;
        if (parseDotenv(line)[name] === value) return line;
      }
      throw new Error('A restored environment value has no lossless supported representation');
    })
    .join('');
}

/** Preserve native agent/provider intent while withholding automatic integrations. */
export function restoredInactiveConfig(
  source: NativeConfig,
  options: {
    gatewayToken: string;
    oldPluginDirectory: string;
    pluginDirectory: string;
  },
): NativeConfig {
  if (!/^[a-f0-9]{48}$/.test(options.gatewayToken))
    throw new Error('Invalid fresh Gateway credential');
  const config = structuredClone(source);
  config.gateway ??= {};
  config.gateway.mode = 'local';
  config.gateway.bind = 'loopback';
  config.gateway.port = 18789;
  config.gateway.auth = {
    ...config.gateway.auth,
    mode: 'token',
    token: options.gatewayToken,
    allowTailscale: false,
  };
  delete config.gateway.auth.password;
  delete config.gateway.auth.trustedProxy;
  config.gateway.tailscale = { ...config.gateway.tailscale, mode: 'off' };
  delete config.gateway.remote;
  config.cron = {
    ...config.cron,
    enabled: false,
    skipMissedJobs: true,
    triggers: { ...config.cron?.triggers, enabled: false },
  };
  config.hooks = {
    ...config.hooks,
    enabled: false,
    internal: { ...config.hooks?.internal, enabled: false },
  };
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    if (['defaults', 'modelByChannel'].includes(id) || !channel || typeof channel !== 'object')
      continue;
    const settings = channel as {
      enabled?: boolean;
      accounts?: Record<string, { enabled?: boolean }>;
    };
    settings.enabled = false;
    for (const account of Object.values(settings.accounts ?? {})) account.enabled = false;
  }
  if (config.plugins?.load?.paths) {
    config.plugins.load.paths = config.plugins.load.paths.map((value) =>
      value === options.oldPluginDirectory ? options.pluginDirectory : value,
    );
  }
  if (config.env) {
    const env = config.env as Record<string, unknown>;
    for (const vars of [env, env.vars]) {
      if (!vars || typeof vars !== 'object') continue;
      const entries = vars as Record<string, unknown>;
      delete entries.OPENCLAW_GATEWAY_PASSWORD;
      if (Object.hasOwn(entries, 'OPENCLAW_GATEWAY_TOKEN'))
        entries.OPENCLAW_GATEWAY_TOKEN = options.gatewayToken;
    }
  }
  return config;
}

/** Caller holds the host lock and has proved bootstrap/runtime/role ownership.
 * Only filtered diagnostics are returned; native commands and secret material stay private.
 */
export async function reconcileNativeRestore(options: {
  job: BackupCaptureJob;
  capture: CapturedBackup;
  owner: RestoreSecretOwner;
  gatewayToken: string;
  pluginDirectory: string;
  ssm: Pick<SSMClient, 'send'>;
  nativePackageJson?: string;
  assertInactive?: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const home = homedir();
  await importRestoreProviderSecrets(options.ssm, options.owner, {});
  const state = path.join(home, '.openclaw');
  const packageJson =
    options.nativePackageJson ??
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/openclaw/package.json');
  const require = createRequire(packageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/config-mutation')).href
  )) as ConfigSdk;
  const assertInactive =
    options.assertInactive ??
    (async () => {
      const result = await execa(
        'systemctl',
        ['--user', 'show', 'openclaw-gateway.service', '--property=ActiveState', '--value'],
        { timeout: 15000 },
      );
      if (!['inactive', 'failed'].includes(result.stdout))
        throw new Error('Restored Gateway must remain inactive during reconciliation');
    });
  await assertInactive();
  const before = await sdk.readConfigFileSnapshotForWrite();
  if (
    !before.snapshot.exists ||
    !before.snapshot.hash ||
    path.resolve(before.snapshot.path) !== path.join(state, 'openclaw.json')
  )
    throw new Error('Restored native configuration is unavailable at the supported path');
  const source = before.snapshot.sourceConfig;
  if (!source) throw new Error('Restored native source configuration is unavailable');
  const config = restoredInactiveConfig(source, {
    gatewayToken: options.gatewayToken,
    oldPluginDirectory: options.job.pluginDirectory,
    pluginDirectory: options.pluginDirectory,
  });
  const envPath = path.join(state, '.env');
  let environment: Record<string, string> = {};
  try {
    const info = await lstat(envPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.size > 1024 * 1024
    )
      throw new Error('Restored environment file is unsafe');
    environment = parseDotenv(await readFile(envPath));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  environment.OPENCLAW_GATEWAY_TOKEN = options.gatewayToken;
  delete environment.OPENCLAW_GATEWAY_PASSWORD;
  const incoming = `${envPath}.restore-${options.owner.operationId}`;
  const serialized = restoredEnvironmentText(environment);
  try {
    await writeFile(incoming, serialized, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const info = await lstat(incoming);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 1024 * 1024 ||
      (await readFile(incoming, 'utf8')) !== serialized
    )
      throw new Error('Restore environment staging differs from this owned credential update', {
        cause: error,
      });
  }
  await rename(incoming, envPath);
  await assertInactive();
  await sdk.replaceConfigFile({
    sourceConfig: config,
    baseHash: before.snapshot.hash,
    afterWrite: { mode: 'none', reason: 'Restore integrations remain inactive until reviewed' },
  });
  const providerEnv = { ...environment };
  for (const entries of [source.env, source.env?.vars]) {
    for (const [name, value] of Object.entries(entries ?? {}))
      if (typeof value === 'string') providerEnv[name] = value;
  }
  const imported = await importRestoreProviderSecrets(options.ssm, options.owner, providerEnv);
  const sessionHold = await holdRestoredSessions({
    owner: options.owner,
    members: options.capture.members,
    nativePackageJson: packageJson,
    journal: path.join(
      home,
      '.openclaw-aws',
      'jobs',
      options.owner.operationId,
      'session-hold.json',
    ),
    assertInactive,
  });
  const childEnv = {
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_HIDE_BANNER: '1',
    NO_COLOR: '1',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true',
  };
  const run = async (args: string[]): Promise<unknown> => {
    try {
      const result = await execa(
        process.execPath,
        [path.join(path.dirname(packageJson), 'openclaw.mjs'), ...args, '--json'],
        {
          env: childEnv,
          extendEnv: false,
          timeout: 120000,
          cancelSignal: options.signal,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        'Restored native diagnostics failed; Gateway remains inactive and no private diagnostic output was published',
      );
    }
  };
  await run(['config', 'validate']);
  const members = parseMembers(await run(['agents', 'list']));
  if (
    members.length !== options.capture.members.length ||
    options.capture.members.some((expected) => {
      const actual = members.find((member) => member.id === expected.id);
      return (
        !actual ||
        actual.workspace !== expected.workspace ||
        actual.agentDir !== expected.agentDir ||
        (expected.model !== undefined && actual.model !== expected.model)
      );
    })
  )
    throw new Error(
      'Restored native roster, member paths or model settings differ from the saved installation',
    );
  const audit = object(await run(['secrets', 'audit']));
  if (
    object(audit.resolution).resolvabilityComplete !== true ||
    object(audit.summary).unresolvedRefCount !== 0
  )
    throw new Error(
      'Restored native credential references are unresolved; Gateway remains inactive',
    );
  await assertInactive();
  return {
    members,
    imported,
    sessionHold,
    integrations: 'paused' as const,
    gateway: 'inactive' as const,
  };
}
