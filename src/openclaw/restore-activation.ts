import { lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execa } from 'execa';
import { object } from './backup-contract.js';
import { inspectRestoredSessionHolds } from './restore-session-hold.js';
import {
  verifiedRestoreTarget,
  privateRestoreJson,
  ownedRestoreRecord,
} from './restore-control.js';
import type { RestoreJob } from './restore-contract.js';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface RestoreActivationResult {
  schemaVersion: 1;
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: 'active-held';
  healthy: true;
  memberCount: number;
  heldSessionCount: number;
}
export interface RestoreActivationHost {
  validate(): Promise<void>;
  unmaskAndInstall(): Promise<void>;
  start(): Promise<void>;
  health(): Promise<void>;
  maskInactive(): Promise<void>;
}

/** Only an explicitly requested activation enters this state transition. */
export async function activateRestoredService(host: RestoreActivationHost) {
  await host.validate();
  try {
    await host.unmaskAndInstall();
    await host.start();
    await host.health();
    await host.validate();
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
        ? 'Restored Gateway activation failed; the service is masked and inactive, and recovery data is retained'
        : 'Restored Gateway activation failed and its inactive hold could not be confirmed; inspect the retained target immediately',
    );
  }
}

export async function runRestoreActivation(
  input: RestoreJob,
  signal?: AbortSignal,
): Promise<RestoreActivationResult> {
  const context = await verifiedRestoreTarget(input, signal, { allowActive: true });
  const { job, root, work, owner, packageJson, operationId, home, digest } = context;
  const ready = await privateRestoreJson(path.join(work, 'ready.json'));
  if (
    ready.operationId !== operationId ||
    ready.stackId !== job.target.stackId ||
    ready.instanceId !== job.target.instanceId ||
    ready.phase !== 'ready-inactive' ||
    ready.memberCount !== job.backup.capture.members.length ||
    !Number.isSafeInteger(ready.heldSessionCount) ||
    (ready.heldSessionCount as number) < 0
  )
    throw new Error('Restore is not certified ready for deliberate activation');
  const result: RestoreActivationResult = {
    schemaVersion: 1,
    operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    phase: 'active-held',
    healthy: true,
    memberCount: ready.memberCount as number,
    heldSessionCount: ready.heldSessionCount as number,
  };
  const ssm = new SSMClient({ region: job.target.region, credentials: context.credentials });
  let gatewayToken: string;
  try {
    const name = `/openclaw/${job.target.deploymentName}/gateway-token`;
    const token = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
      context.request(),
    );
    if (
      token.Parameter?.Name !== name ||
      token.Parameter.Type !== 'SecureString' ||
      !token.Parameter.Value
    )
      throw new Error('Fresh target Gateway credential is unavailable');
    gatewayToken = token.Parameter.Value;
  } finally {
    ssm.destroy();
  }
  const require = createRequire(packageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/config-mutation')).href
  )) as typeof import('openclaw/plugin-sdk/config-mutation');
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
  const validate = async () => {
    const snapshot = await sdk.readConfigFileSnapshotForWrite();
    if (!snapshot.snapshot.valid || !snapshot.snapshot.sourceConfig)
      throw new Error('Restored configuration is not valid');
    const config = snapshot.snapshot.sourceConfig;
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
        throw new Error('A restored messaging integration is no longer paused');
    }
    const held = await inspectRestoredSessionHolds({
      owner,
      members: job.backup.capture.members,
      nativePackageJson: packageJson,
      journal: path.join(work, 'session-hold.json'),
    });
    if (held.held !== ready.heldSessionCount)
      throw new Error('Restored session hold count changed');
  };
  const health = async () => {
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
    throw new Error('Restored Gateway did not establish authenticated native health');
  };
  const activatedFile = path.join(work, 'activated.json');
  const releaseMaintenance = async () => {
    try {
      const record = await privateRestoreJson(path.join(root, 'maintenance.json'));
      if (
        record.kind !== 'restore' ||
        record.operationId !== operationId ||
        record.stackId !== job.target.stackId ||
        record.roleId !== job.target.roleId ||
        record.digest !== digest
      )
        throw new Error(
          'Maintenance ownership changed after activation; inspect before another mutation',
        );
      await rm(path.join(root, 'maintenance.json'));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  };
  try {
    const activated = await privateRestoreJson(activatedFile);
    if (JSON.stringify(activated) !== JSON.stringify(result))
      throw new Error('Existing activation receipt differs from this restore');
    await validate();
    await health();
    await releaseMaintenance();
    return result;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await context.assertInactive();
  const maintenance = await privateRestoreJson(path.join(root, 'maintenance.json'));
  if (
    maintenance.kind !== 'restore' ||
    maintenance.operationId !== operationId ||
    maintenance.stackId !== job.target.stackId ||
    maintenance.roleId !== job.target.roleId ||
    maintenance.digest !== digest
  )
    throw new Error('Another maintenance operation owns this target');
  await activateRestoredService({
    validate,
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
      await context.assertInactive();
    },
  });
  await ownedRestoreRecord(activatedFile, result);
  // Host completion is durable independently of the operator's laptop or SSM reply.
  await releaseMaintenance();
  return result;
}
