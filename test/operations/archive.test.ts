import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const mocks = vi.hoisted(() => ({
  root: '',
  target: {} as object,
  source: {} as object,
  deletion: {} as object,
  point: {} as object,
  rows: new Map<string, unknown>(),
  events: [] as string[],
  create: vi.fn(),
  verify: vi.fn(),
  current: vi.fn(),
  remove: vi.fn(),
  audit: vi.fn(),
  parameters: vi.fn(),
  ssm: vi.fn(),
  sourceRead: vi.fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({
  getConfigRoot: () => mocks.root,
  getConfigPathByName: (name: string) => path.join(mocks.root, 'configs', name + '.json'),
  getOutputsPathByName: (name: string) => path.join(mocks.root, 'outputs', name + '.json'),
  loadConfigByName: vi.fn(),
}));
vi.mock('../../src/cli/utils/config-store.js', () => ({
  getCurrentName: () => null,
  listConfigNames: () => [],
  setCurrentName: vi.fn(),
  clearCurrentName: vi.fn(),
}));
vi.mock('../../src/operations/state.js', () => ({
  assertDeploymentTarget: vi.fn(),
  loadDeploymentState: () => undefined,
}));
vi.mock('../../src/aws/target.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAwsTarget: async () => mocks.target,
}));
vi.mock('../../src/aws/recovery-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  inspectRecoverySource: (...args: unknown[]) => mocks.sourceRead(...args),
}));
vi.mock('../../src/aws/archive-deletion.js', () => ({
  planArchiveDeletion: async () => mocks.deletion,
  assertArchiveDeletionCurrent: (...args: unknown[]) => mocks.current(...args),
  deleteArchivedStack: (...args: unknown[]) => mocks.remove(...args),
  auditArchivedCompute: (...args: unknown[]) => mocks.audit(...args),
  deleteArchivedParameters: (...args: unknown[]) => mocks.parameters(...args),
}));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: (...args: unknown[]) => mocks.ssm(...args) }));
vi.mock('../../src/operations/vault.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRecoveryVault: async () => backupVault,
}));
vi.mock('../../src/operations/backup.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBackup: (...args: unknown[]) => mocks.create(...args),
  verifyBackup: (...args: unknown[]) => mocks.verify(...args),
  inspectBackup: async () => mocks.point,
}));
vi.mock('../../src/aws/recovery-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recoveryStore: () => ({
    async read(name: string) {
      const value = mocks.rows.get(name);
      return value === undefined
        ? undefined
        : {
            value: structuredClone(value),
            versionId: 'metadata-version',
            checksumSHA256: 'unused',
          };
    },
    async putImmutable(name: string, value: unknown) {
      const normalized = JSON.parse(JSON.stringify(value));
      if (mocks.rows.has(name) && !isDeepStrictEqual(mocks.rows.get(name), normalized))
        throw new Error('Immutable metadata collision');
      mocks.rows.set(name, normalized);
      mocks.events.push(name);
      return { value: normalized, versionId: 'metadata-version', checksumSHA256: 'unused' };
    },
    close() {},
  }),
}));
import {
  planArchive,
  createArchive,
  resumeArchive,
  inspectArchive,
  abortArchive,
} from '../../src/operations/archive.js';
import {
  archiveCaptureDigest,
  backupJobDigest,
  type BackupCaptureJob,
} from '../../src/openclaw/backup-contract.js';
import { recoveryArtifactFilenames } from '../../src/aws/recovery-artifact.js';
import {
  backupSource,
  backupJob,
  backupCapture,
  backupReceipt,
  backupVault,
  backupId,
} from '../helpers/fixtures/backup.js';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';
import type { CommandContext } from '../../src/cli/utils/context.js';
import type { BackupPreparation } from '../../src/operations/backup.js';
let ctx: CommandContext;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.events = [];
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-operations-'));
  const target = { ...testTarget, region: 'eu-central-1', profile: 'acceptance' };
  mocks.target = target;
  const source = {
    ...structuredClone(backupSource),
    role: { ...backupSource.role, id: 'AROATESTHOSTROLE000001' },
  };
  mocks.source = source;
  mocks.sourceRead.mockResolvedValue(source);
  ctx = makeCommandContext({
    target,
    config: {
      version: '1.0',
      aws: { region: target.region },
      network: { useDefaultVpc: true },
      instance: { name: 'alpha', type: 't3a.small' },
      features: { cloudWatchLogs: false },
      stack: { name: source.stackName },
      openclaw: { apiProvider: 'openrouter-api-key' },
    },
  });
  mocks.deletion = {
    deploymentName: 'alpha',
    source,
    templateDigest: 'a'.repeat(64),
    volumeId: 'vol-0123456789abcdef0',
    parameters: [
      {
        name: '/openclaw/alpha/gateway-token',
        arn: 'arn:aws:ssm:eu-central-1:123456789012:parameter/openclaw/alpha/gateway-token',
        version: 1,
        modifiedAt: '2026-11-06T00:00:00.000Z',
      },
    ],
  };
  mocks.verify.mockImplementation(async () => {
    mocks.events.push('verify');
    return { verified: true };
  });
  mocks.current.mockImplementation(async () => {
    mocks.events.push('current');
  });
  mocks.remove.mockImplementation(async () => {
    mocks.events.push('delete');
  });
  mocks.audit.mockResolvedValue({});
  mocks.parameters.mockResolvedValue(undefined);
  mocks.create.mockImplementation(async (_ctx, options) => {
    mocks.events.push('capture');
    const files = recoveryArtifactFilenames.map((name, index) => ({
      name,
      key: '',
      versionId: 'artifact-version',
      sha256: createHash('sha256')
        .update(name + index)
        .digest('hex'),
    }));
    const digest = createHash('sha256')
      .update(JSON.stringify(files.map((f) => [f.name, f.sha256])))
      .digest('hex');
    const job: BackupCaptureJob = {
      ...structuredClone(backupJob),
      source: { ...backupJob.source, roleId: source.role.id },
      pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${digest}`,
      archive: options.archive,
    };
    for (const file of files) file.key = `${job.settings.prefix}/_tools/${digest}/${file.name}`;
    const preparation: BackupPreparation = {
      job,
      source,
      artifact: { digest, files },
      request: {
        key: `${job.settings.prefix}/_operations/${job.operationId}/request.json`,
        versionId: 'request-version',
        sha256: backupJobDigest(job),
      },
    };
    const capture = structuredClone(backupCapture);
    capture.gateway = {
      initial: 'active',
      restored: false,
      held: { kind: 'archive', operationId: job.operationId, requestDigest: backupJobDigest(job) },
    };
    mocks.point = { ...structuredClone(backupReceipt), job, capture };
    await options.beforeCapture(preparation);
    return mocks.point;
  });
  mocks.ssm.mockImplementation(async (_id, _target, commands: string[]) => {
    const command = commands.join('\n');
    if (command.includes('agents list')) return { stdout: JSON.stringify(backupCapture.members) };
    if (command.includes('--lock-archive-commit')) {
      mocks.events.push('host-commit');
      const point = mocks.point as typeof backupReceipt;
      return {
        stdout: JSON.stringify({
          ok: true,
          operationId: backupId,
          recordedPhase: 'destroy-committed',
          requestDigest: backupJobDigest(point.job),
          captureDigest: archiveCaptureDigest(point.capture, point.job),
        }),
      };
    }
    if (command.includes('--lock-archive-abort'))
      return {
        stdout: JSON.stringify({ ok: true, operationId: backupId, recordedPhase: 'aborted' }),
      };
    if (command.includes('--lock-archive-inspect'))
      return {
        stdout: JSON.stringify({
          ok: true,
          operationId: backupId,
          recordedPhase: 'verified-held',
          gatewayHeld: true,
        }),
      };
    throw new Error('Unexpected fixture SSM command');
  });
});
afterEach(() => fs.rmSync(mocks.root, { recursive: true, force: true }));
const plan = () => planArchive(ctx, { vaultUri: backupVault.uri, operationId: backupId });
describe('complete archive application workflow', () => {
  it('persists a whole-host recovery point and native commitment before deleting the source exactly once', async () => {
    const output = await createArchive(ctx, await plan());
    expect(output).toMatchObject({
      recordedPhase: 'archived',
      pointId: backupId,
      sourceStackId: backupSource.stackId,
      localConfig: 'absent',
    });
    expect(mocks.events.indexOf('capture')).toBeLessThan(mocks.events.indexOf('verify'));
    expect(mocks.events.indexOf('verify')).toBeLessThan(mocks.events.indexOf('host-commit'));
    expect(mocks.events.indexOf(`archives/${backupId}/destroy-intent.json`)).toBeLessThan(
      mocks.events.indexOf('delete'),
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalled();
    expect(mocks.parameters).toHaveBeenCalledOnce();
    expect(output.retained.join(' ')).toContain('key');
    expect(output.restoreCommand).toContain('--profile');
  });
  it('does not capture a partial team or delete its unrelated co-hosted members', async () => {
    await expect(
      planArchive(ctx, {
        vaultUri: backupVault.uri,
        operationId: backupId,
        expectedMembers: [{ id: 'other', workspace: '/other', agentDir: '/other/agent' }],
      }),
    ).rejects.toThrow(/roster changed/);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('restores the source after independent verification fails and refuses teardown', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('independent native readback failed'));
    await expect(createArchive(ctx, await plan())).rejects.toThrow(
      /original service state was restored/,
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.events).not.toContain('host-commit');
    expect(mocks.rows.has(`archives/${backupId}/aborted.json`)).toBe(true);
  });
  it('resumes committed teardown from a clean client without another capture or commit', async () => {
    mocks.remove.mockRejectedValueOnce(new Error('CloudFormation deletion incomplete'));
    await expect(createArchive(ctx, await plan())).rejects.toThrow(/incomplete/);
    fs.rmSync(mocks.root, { recursive: true, force: true });
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-clean-client-'));
    const output = await resumeArchive({
      vaultUri: backupVault.uri,
      operationId: backupId,
      region: 'eu-central-1',
    });
    expect(output.recordedPhase).toBe('archived');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.events.filter((e) => e === 'host-commit')).toHaveLength(1);
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });
  it('refuses replacement of the old named host before granting backup access', async () => {
    const approved = await plan();
    mocks.sourceRead.mockResolvedValueOnce({ ...mocks.source, instanceId: 'i-fffffffffffffffff' });
    await expect(createArchive(ctx, approved)).rejects.toThrow(/source was replaced/);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('blocks abort after committed teardown and preserves credentials on partial deletion', async () => {
    mocks.remove.mockRejectedValueOnce(new Error('partial delete'));
    await expect(createArchive(ctx, await plan())).rejects.toThrow(/partial delete/);
    await expect(
      abortArchive({ vaultUri: backupVault.uri, operationId: backupId, region: 'eu-central-1' }),
    ).rejects.toThrow(/teardown is committed/);
    expect(mocks.parameters).not.toHaveBeenCalled();
    await expect(
      inspectArchive({ vaultUri: backupVault.uri, operationId: backupId, region: 'eu-central-1' }),
    ).resolves.toMatchObject({ recordedPhase: 'verified-held' });
  });
});
