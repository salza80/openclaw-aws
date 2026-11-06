import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { cloneRecordFixture, clonePreviewFixture } from '../helpers/fixtures/clone.js';
import { backupReceipt, backupVault, backupSource } from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  source: vi.fn(),
  vault: vi.fn(),
  access: vi.fn(),
  remove: vi.fn(),
  removeSource: vi.fn(),
  artifact: vi.fn(),
  put: vi.fn(),
  remote: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
  inspect: vi.fn(),
  lock: vi.fn(),
  state: vi.fn(),
  guard: vi.fn(),
  ssm: vi.fn(),
}));
vi.mock('../../src/operations/deployment.js', () => ({ provisionInactiveTarget: mocks.provision }));
vi.mock('../../src/aws/recovery-source.js', async (load) => ({
  ...(await load<object>()),
  inspectRecoverySource: mocks.source,
  removeSourceRecoveryAccess: mocks.removeSource,
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
  recoveryStore: () => ({ putImmutable: mocks.put, close: vi.fn() }),
}));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: mocks.remote }));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: () => ({ send: mocks.ssm, destroy: vi.fn() }),
}));
import { resumeClone, stageClone, type ClonePlan } from '../../src/operations/clone.js';
import { loadCloneRecord } from '../../src/operations/clone-record.js';
import { recoveryRecordPath } from '../../src/operations/recovery-record.js';
let directory: string;
let plan: ClonePlan;
const target = { ...testTarget, arn: 'arn:aws:sts::123456789012:assumed-role/operator/session' };
const recoveryTarget = { ...target, region: 'eu-central-1' };
const fixture = cloneRecordFixture();
const host = {
  ...backupSource,
  stackId: fixture.target!.stackId,
  instanceId: fixture.target!.instanceId,
  role: { ...backupSource.role, name: 'target-role', id: fixture.delivery!.job.target.roleId },
};
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), 'clone-stage-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  plan = {
    schemaVersion: 1,
    operationId: fixture.operationId,
    bootstrap: structuredClone(fixture.bootstrap),
    point: structuredClone(backupReceipt),
    preview: clonePreviewFixture(),
    prerequisites: [],
    context: {
      name: fixture.name,
      config: structuredClone(fixture.config),
      target,
      awsEnv: {},
      configPath: path.join(directory, '.openclaw-aws/configs/restored.json'),
    },
  };
  mocks.provision.mockImplementation(async (_ctx, _options, finish) =>
    finish({
      DeploymentId: host.stackId,
      InstanceId: host.instanceId,
    }),
  );
  mocks.source.mockResolvedValue(host);
  mocks.vault.mockResolvedValue(backupVault);
  mocks.resolve.mockImplementation(async ({ region }) =>
    region === 'eu-central-1' ? recoveryTarget : target,
  );
  mocks.status.mockResolvedValue({
    stackId: host.stackId,
    instanceId: host.instanceId,
    stackName: fixture.config.stack.name,
    stackStatus: 'CREATE_COMPLETE',
  });
  mocks.inspect.mockResolvedValue(structuredClone(backupReceipt));
  mocks.lock.mockImplementation(async (_ctx, run) => run());
  mocks.artifact.mockResolvedValue(fixture.delivery!.artifact);
  mocks.put.mockImplementation(async (_key, job) => ({
    versionId: 'request-version',
    checksumSHA256: createHash('sha256').update(JSON.stringify(job)).digest('base64'),
  }));
  mocks.ssm.mockResolvedValue({});
  mocks.remote.mockImplementation(async (_id, _target, commands) => {
    if (commands[0].includes('restore-bootstrap.json'))
      return { stdout: JSON.stringify({ verified: true, masked: true, inactive: true }) };
    if (commands[0].includes('--lock-activate-clone')) {
      return {
        stdout: JSON.stringify({ ...fixture.result, phase: 'active', healthy: true, ok: true }),
      };
    }
    return { stdout: JSON.stringify({ ...fixture.result, ok: true }) };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function stage() {
  return stageClone(plan, recoveryTarget, { 'openrouter-api-key': 'explicit-target-key' });
}
describe('independent clone AWS operations', () => {
  it('reports unknown Gateway state after an unconfirmed activation, without publishing worker details', async () => {
    await stage();
    mocks.remote.mockResolvedValueOnce({
      stdout: JSON.stringify({ verified: true, masked: true, inactive: true }),
    });
    mocks.remote.mockRejectedValueOnce(new Error('private-worker-details'));
    await expect(resumeClone(plan.operationId, { activate: true })).rejects.toThrow(
      'Gateway may be running',
    );
    expect(loadCloneRecord(plan.operationId).phase).toBe('ready-inactive');
  });
  it('provisions once, imports explicit target credentials and removes source access while inactive', async () => {
    const record = await stage();
    expect(record.phase).toBe('ready-inactive');
    expect(record.permissionCleanupPending).toBe(false);
    expect(mocks.provision.mock.calls[0][1]).toMatchObject({
      clonedFrom: { pointId: backupReceipt.id },
    });
    expect(mocks.access.mock.calls[0][1].access.secretImport.readOnly).toBe(true);
    expect(mocks.ssm.mock.calls[0][0].input).toMatchObject({
      Name: '/openclaw/restored/providers/openrouter-api-key/api-key',
      Value: 'explicit-target-key',
      Overwrite: false,
    });
    expect(mocks.remove).toHaveBeenCalledOnce();
    const saved = fs.readFileSync(recoveryRecordPath('clones', record.operationId), 'utf8');
    expect(saved).not.toContain('explicit-target-key');
    expect(JSON.stringify(mocks.put.mock.calls)).not.toContain('explicit-target-key');
    expect(JSON.stringify(mocks.remote.mock.calls)).not.toContain('explicit-target-key');
    expect(loadCloneRecord(record.operationId)).toEqual(record);
  });
  it('activates only installed pinned code after revoking access, with no source grant or upload', async () => {
    await stage();
    vi.clearAllMocks();
    const result = await resumeClone(plan.operationId, { activate: true });
    expect(result.phase).toBe('active');
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.artifact).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.removeSource).toHaveBeenCalledOnce();
    expect(mocks.removeSource.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remote.mock.invocationCallOrder[1],
    );
    const command = mocks.remote.mock.calls[1][2][0];
    expect(command).toContain('--lock-activate-clone');
    expect(command).toContain('sha256sum');
    expect(command).not.toContain('s3api');
  });
  it('refuses missing targets, account drift, and uncertified running hosts without provisioning or source grants', async () => {
    const record = await stage();
    vi.clearAllMocks();
    mocks.status.mockRejectedValueOnce(new StackNotFoundError(fixture.config.stack.name));
    await expect(resumeClone(record.operationId)).rejects.toThrow('absent');
    mocks.resolve.mockResolvedValueOnce({ ...target, account: '999999999999' });
    await expect(resumeClone(record.operationId)).rejects.toThrow('pinned clone account');
    const filename = recoveryRecordPath('clones', record.operationId);
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    delete raw.result;
    raw.phase = 'cloning';
    fs.writeFileSync(filename, JSON.stringify(raw));
    mocks.remote.mockResolvedValueOnce({
      stdout: JSON.stringify({ verified: true, masked: false, inactive: false }),
    });
    await expect(resumeClone(record.operationId)).rejects.toThrow('not confirmed masked');
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it('retains the owned journal and masked target after an uncertain remote response', async () => {
    mocks.remote.mockRejectedValueOnce(new Error('secret-bearing remote details'));
    await expect(stage()).rejects.toThrow('resources may remain billable');
    const record = loadCloneRecord(plan.operationId);
    expect(record.phase).toBe('cloning');
    expect(record.permissionCleanupPending).toBe(true);
    expect(record.result).toBeUndefined();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.remote.mock.calls[0][2][0]).not.toContain('--lock-activate');
  });
});
