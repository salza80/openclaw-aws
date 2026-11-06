import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import type { Provider } from '../cli/types/index.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { OPENCLAW_PROVIDER_SETUP, openClawProviderAuthArgs } from './install.js';
import { object } from './backup-contract.js';
import { verifyNativeClone } from './clone-validate.js';
import { cloneContentDigest, type CloneContentPlan } from './clone-content.js';
import type { CloneSourcePolicy } from './clone-policy.js';
import { inactiveCloneConfig } from './clone-config.js';
import { restoredEnvironmentText } from './restore-reconciliation.js';
import { assertDirectoryChain } from './restore-layout.js';

/** Fresh native identity creation only. The caller owns the maintenance lock,
 * has installed the reviewed content and keeps the Gateway masked. Interrupted
 * initialization is retained for inspection, never replayed over native state.
 */
export async function initializeNativeClone(options: {
  content: CloneContentPlan;
  policy: CloneSourcePolicy;
  apiProvider: Provider;
  providerCredential: string;
  /** Extra explicitly supplied credentials for a roster using several providers. */
  additionalCredentials?: Partial<Record<Provider, string>>;
  gatewayToken: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  nativePackageJson?: string;
  assertInactive: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const home = homedir();
  const state = path.join(home, '.openclaw');
  const configPath = path.join(state, 'openclaw.json');
  const packageJson =
    options.nativePackageJson ??
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/openclaw/package.json');
  const setup = OPENCLAW_PROVIDER_SETUP[options.apiProvider];
  if (
    !setup ||
    !options.providerCredential ||
    /[\0\r\n]/.test(options.providerCredential) ||
    Buffer.byteLength(options.providerCredential) > 4096 ||
    !/^[a-f0-9]{48}$/.test(options.gatewayToken)
  )
    throw new Error('Clone requires explicit supported fresh provider and Gateway credentials');
  const providerEnvironment: Record<string, string> = {
    [setup.envVar]: options.providerCredential,
  };
  for (const [provider, credential] of Object.entries(options.additionalCredentials ?? {})) {
    if (
      !Object.hasOwn(OPENCLAW_PROVIDER_SETUP, provider) ||
      typeof credential !== 'string' ||
      !credential ||
      /[\0\r\n]/.test(credential) ||
      Buffer.byteLength(credential) > 4096
    )
      throw new Error('An explicitly supplied clone provider credential is unsupported');
    const name = OPENCLAW_PROVIDER_SETUP[provider as Provider].envVar;
    if (providerEnvironment[name] !== undefined && providerEnvironment[name] !== credential)
      throw new Error('Explicit clone provider credentials disagree');
    providerEnvironment[name] = credential;
  }
  if (
    process.version !== `v${OPENCLAW_NODE_VERSION}` ||
    JSON.parse(await readFile(packageJson, 'utf8')).version !== OPENCLAW_VERSION
  )
    throw new Error('Clone creation requires the supported pinned native runtime');
  if (
    options.content.digest !==
      cloneContentDigest(options.content.members, options.content.sharedSkills) ||
    !options.content.members.length ||
    options.content.members.some(
      (member) =>
        member.workspace !== `${state}/workspaces/${member.id}` ||
        member.agentDir !== `${state}/agents/${member.id}/agent`,
    )
  )
    throw new Error('Clone content does not match this fresh native target');
  const ids = new Set(options.content.members.map((member) => member.id));
  if (
    ids.size !== options.content.members.length ||
    options.content.members.some((member) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.id)) ||
    options.policy.agents.length !== ids.size ||
    new Set(options.policy.agents.map((agent) => agent.id)).size !== ids.size ||
    options.policy.agents.some((agent) => !ids.has(agent.id)) ||
    (options.policy.systemAgent && !ids.has(options.policy.systemAgent))
  )
    throw new Error('Clone source policy does not cover this complete native roster');
  if (
    (process.env.OPENCLAW_CONFIG_PATH && process.env.OPENCLAW_CONFIG_PATH !== configPath) ||
    (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_STATE_DIR !== state)
  )
    throw new Error('Clone native configuration environment points at another installation');
  await options.assertInactive();
  await mkdir(state, { recursive: true, mode: 0o700 });
  await assertDirectoryChain(state, home, false);
  for (const filename of [configPath, path.join(state, '.env')]) {
    try {
      await lstat(filename);
      throw new Error(
        'Clone initialization requires fresh native configuration; inspect and clean up an interrupted target before retrying',
      );
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  const first =
    // Native `agents add` reserves main after another first agent exists.
    // Bootstrap it first when present; reconcile the saved coordinator later.
    options.content.members.find((member) => member.id === 'main') ??
    options.content.members.find((member) => member.id === options.policy.systemAgent) ??
    options.content.members[0];
  const env = {
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_HIDE_BANNER: '1',
    NO_COLOR: '1',
    OPENCLAW_DEFER_SHELL_ENV_FALLBACK: '1',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true',
    ...providerEnvironment,
    OPENCLAW_GATEWAY_TOKEN: options.gatewayToken,
  };
  const file = await open(
    path.join(state, '.env'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(
      restoredEnvironmentText({
        ...providerEnvironment,
        OPENCLAW_GATEWAY_TOKEN: options.gatewayToken,
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const native = async (args: string[], input?: string, json = true) => {
    await options.assertInactive();
    try {
      const result = await execa(
        process.execPath,
        [
          path.join(path.dirname(packageJson), 'openclaw.mjs'),
          ...args,
          ...(input === undefined && json ? ['--json'] : []),
        ],
        {
          env,
          extendEnv: false,
          timeout: 180000,
          cancelSignal: options.signal,
          maxBuffer: 8 * 1024 * 1024,
          ...(input !== undefined ? { input } : {}),
        },
      );
      return input === undefined && json ? (JSON.parse(result.stdout) as unknown) : undefined;
    } catch {
      throw new Error(
        'Fresh native clone setup failed; Gateway remains inactive and private output was not published',
      );
    }
  };
  const onboarded = object(
    await native([
      'onboard',
      '--non-interactive',
      '--accept-risk',
      '--mode',
      'local',
      '--agent-name',
      first.id,
      '--workspace',
      first.workspace,
      ...openClawProviderAuthArgs(options),
      '--secret-input-mode',
      'ref',
      '--gateway-port',
      '18789',
      '--gateway-bind',
      'loopback',
      '--gateway-auth',
      'token',
      '--gateway-token-ref-env',
      'OPENCLAW_GATEWAY_TOKEN',
      '--skip-daemon',
      '--skip-skills',
      '--skip-channels',
      '--skip-search',
      '--skip-hooks',
      '--skip-ui',
      '--skip-health',
      '--skip-bootstrap',
      '--suppress-gateway-token-output',
    ]),
  );
  if (onboarded.ok !== true || onboarded.installDaemon !== false || onboarded.skipHealth !== true)
    throw new Error('Native clone onboarding did not confirm inactive fresh setup');
  for (const member of options.content.members.filter((member) => member.id !== first.id)) {
    const result = object(
      await native([
        'agents',
        'add',
        member.id,
        '--workspace',
        member.workspace,
        '--agent-dir',
        member.agentDir,
        '--non-interactive',
      ]),
    );
    if (
      result.agentId !== member.id ||
      result.workspace !== member.workspace ||
      result.agentDir !== member.agentDir
    )
      throw new Error('Native clone agent creation differs from the reviewed role mapping');
  }
  const require = createRequire(packageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/config-mutation')).href
  )) as typeof import('openclaw/plugin-sdk/config-mutation');
  const before = await sdk.readConfigFileSnapshotForWrite({ observe: false });
  if (
    !before.snapshot.valid ||
    !before.snapshot.sourceConfig ||
    before.snapshot.path !== configPath ||
    !before.snapshot.hash
  )
    throw new Error('Fresh native clone configuration is unavailable');
  const config = inactiveCloneConfig({
    fresh: before.snapshot.sourceConfig,
    content: options.content,
    policy: options.policy,
    gatewayToken: options.gatewayToken,
  });
  await options.assertInactive();
  await sdk.replaceConfigFile({
    sourceConfig: config,
    baseHash: before.snapshot.hash,
    afterWrite: {
      mode: 'none',
      reason: 'Independent clone integrations remain disconnected until reviewed',
    },
  });
  // A model API environment variable is not an active native agent profile for
  // every provider. Use the public stdin-only credential writer on fresh stores;
  // never import source auth profiles or put credentials in argv.
  for (const providerSetup of Object.values(OPENCLAW_PROVIDER_SETUP)) {
    const credential = providerEnvironment[providerSetup.envVar];
    if (!credential) continue;
    await native(['plugins', 'enable', providerSetup.providerId], undefined, false);
    for (const member of options.content.members)
      await native(
        [
          'models',
          'auth',
          'paste-api-key',
          '--provider',
          providerSetup.providerId,
          '--agent',
          member.id,
        ],
        `${credential}\n`,
      );
  }
  const verified = await verifyNativeClone({
    members: options.content.members,
    nativePackageJson: packageJson,
    signal: options.signal,
  });
  await options.assertInactive();
  return { ...verified, integrations: 'disconnected' as const, gateway: 'inactive' as const };
}
