import { lstat, mkdir, readlink, rename, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execa } from 'execa';
import { object } from './backup-contract.js';
import { bedrockRoleProfile } from './bedrock-profile.js';
import { createNativeModelClient } from './model-client.js';
import {
  bedrockNativeSnapshot,
  inspectNativeBedrockPlugin,
  nativeBedrockConfigured,
  refreshNativeBedrockDiscovery,
} from './bedrock-native.js';
export interface RecoveryActivationHost {
  validate(): Promise<void>;
  unmaskAndInstall(): Promise<void>;
  start(): Promise<void>;
  health(): Promise<void>;
  maskInactive(): Promise<void>;
  commit?(): Promise<void>;
}

/** Only an explicitly requested activation enters this state transition. */
export async function activateRecoveryService(host: RecoveryActivationHost) {
  await host.validate();
  try {
    await host.unmaskAndInstall();
    await host.start();
    await host.health();
    await host.validate();
    await host.commit?.();
  } catch {
    let inactive = false;
    try {
      await host.maskInactive();
      inactive = true;
    } catch {
      /* Report uncertainty below. */
    }
    throw new Error(
      inactive
        ? 'Recovery Gateway activation failed; the service is masked and inactive, and recovery data is retained'
        : 'Recovery Gateway activation failed and its inactive hold could not be confirmed; inspect the retained target immediately',
    );
  }
}

export function createRecoveryServiceHost(options: {
  home: string;
  work: string;
  packageJson: string;
  gatewayToken: string;
  signal?: AbortSignal;
  validate: () => Promise<void>;
  assertInactive: () => Promise<void>;
  commit?: () => Promise<void>;
  bedrock?: { deploymentRegion: string; inferenceRegion: string };
}): RecoveryActivationHost {
  const { home, work, packageJson, gatewayToken, signal, validate } = options;
  const childEnv = {
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    OPENCLAW_STATE_DIR: path.join(home, '.openclaw'),
    OPENCLAW_CONFIG_PATH: path.join(home, '.openclaw/openclaw.json'),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
    NO_COLOR: '1',
    OPENCLAW_HIDE_BANNER: '1',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true',
    ...(options.bedrock
      ? bedrockRoleProfile(home, options.bedrock.deploymentRegion).environment
      : {}),
  };
  const native = async (args: string[], timeout = 120000) => {
    try {
      return await execa(
        process.execPath,
        [path.join(path.dirname(packageJson), 'openclaw.mjs'), ...args],
        { env: childEnv, extendEnv: false, timeout, cancelSignal: signal, maxBuffer: 1024 * 1024 },
      );
    } catch {
      throw new Error('Native activation command failed; private output was not published');
    }
  };
  const systemctl = (args: string[]) =>
    execa('systemctl', ['--user', ...args], { timeout: 60000, maxBuffer: 1024 * 1024 });
  const gatewayHealth = async () => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        if (
          object(
            JSON.parse(
              (
                await native(
                  ['health', '--json'],
                  Math.max(1, Math.min(10000, deadline - Date.now())),
                )
              ).stdout,
            ),
          ).ok === true
        )
          return;
      } catch {
        /* Native readiness can follow service activation. */
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Recovery Gateway did not establish authenticated native health');
  };
  const health = async () => {
    await gatewayHealth();
    if (options.bedrock) {
      const client = createNativeModelClient({
        home,
        packageJson,
        gatewayToken,
        signal,
        bedrockDeploymentRegion: options.bedrock.deploymentRegion,
        record: async () => {},
      });
      const current = await bedrockNativeSnapshot(client);
      if (!nativeBedrockConfigured(current.config, { home, ...options.bedrock }))
        throw new Error(
          'Active recovery Gateway has not published the approved Bedrock role connection',
        );
      const plugin = await inspectNativeBedrockPlugin(client);
      if (!plugin.installed || !plugin.enabled)
        throw new Error('Active recovery Gateway has not loaded the reviewed Bedrock plugin');
      await refreshNativeBedrockDiscovery(client, { signal });
    }
  };
  return {
    validate,
    commit: options.commit,
    async unmaskAndInstall() {
      await systemctl(['unmask', 'openclaw-gateway.service']);
      await native([
        'gateway',
        'install',
        '--force',
        '--runtime',
        'node',
        '--port',
        '18789',
        '--json',
      ]);
    },
    async start() {
      await native(['gateway', 'start', '--json'], 180000);
    },
    health,
    async maskInactive() {
      await systemctl(['stop', 'openclaw-gateway.service']).catch(() => {});
      const unit = path.join(home, '.config/systemd/user/openclaw-gateway.service');
      await mkdir(path.dirname(unit), { recursive: true, mode: 0o700 });
      let alreadyMasked = false;
      try {
        const stat = await lstat(unit);
        if (stat.isSymbolicLink()) {
          if ((await readlink(unit)) !== '/dev/null')
            throw new Error('Gateway service path has foreign ownership');
          alreadyMasked = true;
        } else {
          if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
            throw new Error('Gateway service definition is unsafe');
          await rename(unit, path.join(work, `failed-gateway-unit-${randomUUID()}.service`));
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (!alreadyMasked) await symlink('/dev/null', unit);
      await systemctl(['daemon-reload']);
      await options.assertInactive();
    },
  };
}

type ConfigSdk = typeof import('openclaw/plugin-sdk/config-mutation');
type NativeConfig = NonNullable<Parameters<ConfigSdk['replaceConfigFile']>[0]['sourceConfig']>;
/** Validate the common paused integration and local authenticated access boundary. */
export function assertInactiveRecoveryConfig(config: NativeConfig, gatewayToken: string) {
  if (
    config.cron?.enabled !== false ||
    config.cron.triggers?.enabled !== false ||
    config.hooks?.enabled !== false ||
    config.hooks.internal?.enabled !== false ||
    config.gateway?.mode !== 'local' ||
    config.gateway.bind !== 'loopback' ||
    config.gateway.port !== 18789 ||
    config.gateway.remote !== undefined ||
    config.gateway.auth?.mode !== 'token' ||
    config.gateway.auth.token !== gatewayToken ||
    config.gateway.auth.allowTailscale !== false ||
    config.gateway.tailscale?.mode !== 'off'
  )
    throw new Error('Automatic integrations or target access settings changed before activation');
  for (const [id, value] of Object.entries(config.channels ?? {})) {
    if (['defaults', 'modelByChannel'].includes(id) || !value || typeof value !== 'object')
      continue;
    const channel = value as {
      enabled?: boolean;
      accounts?: Record<string, { enabled?: boolean }>;
    };
    if (
      channel.enabled !== false ||
      Object.values(channel.accounts ?? {}).some((account) => account.enabled !== false)
    )
      throw new Error('A recovery messaging integration is no longer paused');
  }
}
