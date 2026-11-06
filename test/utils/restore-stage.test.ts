import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupReceipt,
  backupSource,
  backupVault,
  restoreJobFixture,
} from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
import { restoreDeliveryFixture } from '../helpers/fixtures/restore-delivery.js';
import { createHash } from 'node:crypto';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  presence: vi.fn(),
  source: vi.fn(),
  vault: vi.fn(),
  access: vi.fn(),
  remove: vi.fn(),
  artifact: vi.fn(),
  put: vi.fn(),
  close: vi.fn(),
  remote: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
  inspect: vi.fn(),
  lock: vi.fn(),
  state: vi.fn(),
  guard: vi.fn(),
}));
vi.mock('../../src/operations/deployment.js', () => ({
  assertRestoreSecretNamespace: vi.fn(),
  provisionRestoreTarget: mocks.provision,
}));
vi.mock('../../src/aws/recovery-presence.js', () => ({ inspectRecoveryPresence: mocks.presence }));
vi.mock('../../src/aws/recovery-source.js', async (load) => ({
  ...(await load<object>()),
  inspectRecoverySource: mocks.source,
}));
vi.mock('../../src/operations/vault.js', () => ({ readRecoveryVault: mocks.vault }));
vi.mock('../../src/aws/auxiliary-stacks.js', () => ({
  ensureRecoveryStack: mocks.access,
  removeRecoveryAccessStack: mocks.remove,
}));
vi.mock('../../src/aws/recovery-artifact.js', async (load) => ({
  ...(await load<object>()),
  uploadRecoveryArtifact: mocks.artifact,
}));
vi.mock('../../src/aws/target.js', async (load) => ({
  ...(await load<object>()),
  resolveAwsTarget: mocks.resolve,
}));
vi.mock('../../src/cli/utils/aws.js', () => ({ getStackStatus: mocks.status }));
vi.mock('../../src/operations/backup.js', async (load) => ({
  ...(await load<object>()),
  inspectBackup: mocks.inspect,
}));
vi.mock('../../src/operations/lock.js', () => ({ withDeploymentLock: mocks.lock }));
vi.mock('../../src/operations/state.js', () => ({
  assertDeploymentTarget: mocks.guard,
  recordDeploymentState: mocks.state,
}));
vi.mock('../../src/aws/recovery-store.js', async (load) => ({
  ...(await load<object>()),
  recoveryStore: () => ({ putImmutable: mocks.put, close: mocks.close }),
}));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: mocks.remote }));
import { resumeRestore, stageRestore, type RestorePlan } from '../../src/operations/restore.js';
let directory: string;
let plan: RestorePlan;
const recoveryTarget = { ...testTarget, region: 'eu-central-1' };
const target = { ...testTarget, region: 'us-east-1' };
const host = {
  ...backupSource,
  stackId: restoreJobFixture.target.stackId,
  instanceId: restoreJobFixture.target.instanceId,
  role: { ...backupSource.role, name: 'target-role', id: restoreJobFixture.target.roleId },
};
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), 'restore-stage-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  plan = {
    schemaVersion: 1,
    operationId: restoreJobFixture.bootstrap.operationId,
    bootstrap: structuredClone(restoreJobFixture.bootstrap),
    point: structuredClone(backupReceipt),
    sourcePresence: { kind: 'gone', stack: 'deleted', archivedInstance: 'terminated' },
    prerequisites: [],
    context: {
      name: 'restored',
      target,
      awsEnv: {},
      configPath: path.join(directory, '.openclaw-aws/configs/restored.json'),
      config: {
        version: '1.0',
        aws: { region: target.region },
        network: { useDefaultVpc: true },
        instance: { type: 't3a.small', name: 'openclaw-restored' },
        features: { cloudWatchLogs: false },
        stack: { name: 'OpenclawStack-restored' },
      },
    },
  };
  mocks.presence.mockResolvedValue(plan.sourcePresence);
  mocks.provision.mockImplementation(async (_ctx, _options, finish) =>
    finish({ DeploymentId: host.stackId, InstanceId: host.instanceId }),
  );
  mocks.source.mockResolvedValue(host);
  mocks.vault.mockResolvedValue(backupVault);
  mocks.resolve.mockImplementation(async ({ region }) =>
    region === 'eu-central-1' ? recoveryTarget : target,
  );
  mocks.status.mockResolvedValue({
    stackId: host.stackId,
    instanceId: host.instanceId,
    stackName: plan.context.config.stack.name,
    stackStatus: 'CREATE_COMPLETE',
  });
  mocks.inspect.mockResolvedValue(structuredClone(backupReceipt));
  mocks.lock.mockImplementation(async (_ctx, run) => run());
  mocks.artifact.mockResolvedValue({
    digest: 'c'.repeat(64),
    files: [
      {
        name: 'restore-worker.js',
        key: 'tools/restore',
        versionId: 'tool-version',
        sha256: 'd'.repeat(64),
      },
    ],
  });
  mocks.put.mockResolvedValue({
    versionId: 'request-version',
    checksumSHA256: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
  });
  mocks.remote.mockResolvedValue({
    stdout: JSON.stringify({
      ok: true,
      schemaVersion: 1,
      operationId: plan.operationId,
      stackId: host.stackId,
      instanceId: host.instanceId,
      phase: 'ready-inactive',
      memberCount: 1,
      heldSessionCount: 2,
      providerParameters: ['/openclaw/restored/providers/openrouter-api-key/api-key'],
    }),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
describe('shared inactive AWS restore operation', () => {
  async function readyForResume() {
    const delivery = restoreDeliveryFixture();
    mocks.artifact.mockResolvedValue(delivery.artifact);
    mocks.put.mockImplementation(async (_name, job) => ({
      versionId: 'request-version',
      checksumSHA256: createHash('sha256').update(JSON.stringify(job)).digest('base64'),
    }));
    await stageRestore(plan, recoveryTarget);
    mocks.artifact.mockClear();
    mocks.put.mockClear();
    mocks.provision.mockClear();
    mocks.remote.mockClear();
    mocks.remote.mockImplementation(async (_id, _target, commands) => {
      if (commands[0].includes('restore-bootstrap.json'))
        return {
          stdout: JSON.stringify({
            bootstrap: {
              schemaVersion: 1,
              operationId: plan.operationId,
              stackId: host.stackId,
              openclaw: plan.bootstrap.runtime.openclaw,
              node: plan.bootstrap.runtime.node,
              gateway: 'masked',
            },
            activation: null,
          }),
        };
      const activation = commands[0].includes('--lock-activate');
      return {
        stdout: JSON.stringify({
          ok: true,
          schemaVersion: 1,
          operationId: plan.operationId,
          stackId: host.stackId,
          instanceId: host.instanceId,
          phase: activation ? 'active-held' : 'ready-inactive',
          healthy: activation ? true : undefined,
          memberCount: 1,
          heldSessionCount: 2,
          providerParameters: ['/openclaw/restored/providers/openrouter-api-key/api-key'],
        }),
      };
    });
  }
  it('resumes with pinned delivery instead of publishing changed code or provisioning another target', async () => {
    await readyForResume();
    const result = await resumeRestore(plan.operationId);
    expect(result.phase).toBe('ready-inactive');
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.artifact).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('activates deliberately, retaining paused work and clearing temporary permission state', async () => {
    await readyForResume();
    const result = await resumeRestore(plan.operationId, { activate: true });
    expect(result.phase).toBe('active-held');
    expect(result.activation?.healthy).toBe(true);
    expect(result.permissionCleanupPending).toBe(false);
    expect(mocks.remote.mock.calls[1][2][0]).toContain('--lock-activate');
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it('reports uncertain Gateway state if an activation reply or rollback cannot be confirmed', async () => {
    await readyForResume();
    const normal = mocks.remote.getMockImplementation()!;
    mocks.remote.mockImplementation(async (...args) => {
      if (args[2][0].includes('restore-bootstrap.json')) return normal(...args);
      throw new Error('private worker failure');
    });
    await expect(resumeRestore(plan.operationId, { activate: true })).rejects.toThrow(
      'Gateway may be running',
    );
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it('never recreates an absent target or adopts a bootstrap from another restore', async () => {
    await readyForResume();
    mocks.status.mockRejectedValueOnce(
      new StackNotFoundError('OpenclawStack-restored', target.region),
    );
    await expect(resumeRestore(plan.operationId)).rejects.toThrow('no new deployment');
    mocks.remote.mockResolvedValueOnce({
      stdout: JSON.stringify({ bootstrap: { operationId: 'other' }, activation: null }),
    });
    await expect(resumeRestore(plan.operationId)).rejects.toThrow('does not belong');
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it('detects a committed host activation after its reply was lost and verifies it without re-staging', async () => {
    await readyForResume();
    const normal = mocks.remote.getMockImplementation()!;
    mocks.remote.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (!args[2][0].includes('restore-bootstrap.json')) return result;
      const value = JSON.parse(result.stdout);
      value.activation = {
        operationId: plan.operationId,
        stackId: host.stackId,
        instanceId: host.instanceId,
        phase: 'active-held',
        healthy: true,
      };
      return { stdout: JSON.stringify(value) };
    });
    expect((await resumeRestore(plan.operationId)).phase).toBe('active-held');
    expect(mocks.remote.mock.calls[1][2][0]).toContain('--lock-activate');
  });
  it('provisions once, uses old-vault/new-target scoped access, validates readiness and removes temporary permissions', async () => {
    const result = await stageRestore(plan, recoveryTarget);
    expect(result.phase).toBe('ready-inactive');
    expect(result.target).toEqual({ stackId: host.stackId, instanceId: host.instanceId });
    expect(mocks.provision.mock.calls[0][1].restore).toEqual(plan.bootstrap);
    const access = mocks.access.mock.calls[0][1];
    expect(access.access).toMatchObject({
      roleName: 'target-role',
      mode: 'read',
      recoveryRegion: 'eu-central-1',
      dataPrefix: backupReceipt.job.settings.prefix,
      secretImport: { deploymentId: host.stackId, operationId: plan.operationId },
    });
    expect(mocks.remove).toHaveBeenCalledWith(target, {
      stackName: access.stackName,
      identity: access.identity,
      roleName: 'target-role',
    });
    const [requestName, job] = mocks.put.mock.calls[0];
    expect(requestName).toBe(`_operations/restore/${plan.operationId}/request.json`);
    expect(job.backup.job.source.region).toBe('eu-central-1');
    expect(job.target.region).toBe('us-east-1');
    const command = mocks.remote.mock.calls[0][2][0];
    expect(command).toContain('restore-worker.js');
    expect(command).toContain('OPENCLAW_CONFIG_PATH=/home/ubuntu/.openclaw/openclaw.json');
    expect(command).not.toContain('onboard --non-interactive');
    expect(fs.existsSync(plan.context.configPath)).toBe(true);
    const journal = path.join(directory, '.openclaw-aws/restores', `${plan.operationId}.json`);
    expect(JSON.parse(fs.readFileSync(journal, 'utf8')).phase).toBe('ready-inactive');
    expect(fs.statSync(journal).mode & 0o077).toBe(0);
  });
  it('refuses a live/retained source before provisioning or saving target configuration', async () => {
    mocks.presence.mockResolvedValue({
      kind: 'retained-host',
      instanceId: backupSource.instanceId,
      state: 'stopped',
    });
    await expect(stageRestore(plan, recoveryTarget)).rejects.toThrow('clone workflow');
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.context.configPath)).toBe(false);
  });
  it('retains cleanup identities and inactive state when remote proof or permission cleanup fails', async () => {
    mocks.remote.mockResolvedValueOnce({
      stdout: JSON.stringify({ ok: true, instanceId: 'i-other' }),
    });
    await expect(stageRestore(plan, recoveryTarget)).rejects.toThrow('may remain billable');
    expect(mocks.remove).not.toHaveBeenCalled();
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(directory, '.openclaw-aws/restores', `${plan.operationId}.json`),
        'utf8',
      ),
    );
    expect(saved.phase).toBe('restoring');
    expect(saved.target.stackId).toBe(host.stackId);
    expect(fs.existsSync(plan.context.configPath)).toBe(true);
  });
});
