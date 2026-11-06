import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupId, backupVault, restoreJobFixture } from '../helpers/fixtures/backup.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  prepare: vi.fn(),
  stage: vi.fn(),
  resume: vi.fn(),
  load: vi.fn(),
  print: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: mocks.target }));
vi.mock('../../src/operations/restore.js', () => ({
  prepareRestore: mocks.prepare,
  stageRestore: mocks.stage,
  resumeRestore: mocks.resume,
}));
vi.mock('../../src/operations/restore-record.js', () => ({ loadRestoreRecord: mocks.load }));
import { runRestoreCommand } from '../../src/cli/commands/restore.js';
const context = makeCommandContext();
const record = {
  schemaVersion: 1,
  operationId: restoreJobFixture.bootstrap.operationId,
  phase: 'ready-inactive',
  name: context.name,
  config: context.config,
  bootstrap: restoreJobFixture.bootstrap,
  recovery: { pointId: backupId, uri: backupVault.uri, region: 'eu-central-1' },
  target: {
    stackId: restoreJobFixture.target.stackId,
    instanceId: restoreJobFixture.target.instanceId,
  },
  result: { memberCount: 1, heldSessionCount: 2 },
  delivery: { privateDiagnostic: 'do-not-publish' },
};
const args = { from: backupId, vault: backupVault.uri, region: 'eu-central-1', yes: true };
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(mocks.print);
  vi.spyOn(console, 'error').mockImplementation(mocks.error);
  mocks.target.mockResolvedValue(context.target);
  mocks.prepare.mockResolvedValue({
    context,
    bootstrap: restoreJobFixture.bootstrap,
    operationId: record.operationId,
    sourcePresence: { kind: 'gone' },
    prerequisites: ['Review pairing and tasks.'],
  });
  mocks.stage.mockResolvedValue(record);
  mocks.resume.mockResolvedValue({
    ...record,
    phase: 'active-held',
    activation: { healthy: true, memberCount: 1, heldSessionCount: 2 },
  });
  mocks.load.mockReturnValue(record);
});
afterEach(() => vi.restoreAllMocks());
describe('restore CLI boundary', () => {
  it('projects recorded Bedrock IAM reconciliation details without publishing native credentials or delivery data', async () => {
    mocks.load.mockReturnValue({
      ...record,
      permissionCleanupPending: true,
      bedrock: { intent: { inferenceRegion: 'us-east-1', models: ['amazon-bedrock/model'] } },
      bedrockIam: {
        phase: 'started',
        access: {
          stackId: 'owned-policy-stack',
          changeSetId: 'owned-change-set',
          privateContext: 'do-not-publish',
        },
      },
    });
    await runRestoreCommand({ action: 'inspect', operationId: record.operationId, json: true });
    const projected = JSON.parse(mocks.print.mock.calls[0][0]);
    expect(projected).toMatchObject({
      permissionCleanupPending: true,
      bedrock: {
        inferenceRegion: 'us-east-1',
        invocationRouteCount: 1,
        recordedIamPhase: 'started',
        policyStack: 'owned-policy-stack',
        changeSetId: 'owned-change-set',
      },
    });
    expect(JSON.stringify(projected)).not.toContain('do-not-publish');
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it('plans and stages with saved/explicit settings and no model key prompt', async () => {
    await runRestoreCommand({
      ...args,
      targetRegion: 'us-east-1',
      instanceType: 't3a.small',
      volumeGib: 60,
      json: true,
    });
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({
      pointId: backupId,
      vaultUri: backupVault.uri,
      region: 'us-east-1',
      volumeGiB: 60,
    });
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.error.mock.calls[0][0]).toContain('Create one');
    expect(mocks.print.mock.calls[0][0]).not.toContain('do-not-publish');
  });
  it('activates only when explicitly selected, with the same operation identity', async () => {
    await runRestoreCommand({ ...args, activate: true });
    expect(mocks.resume).toHaveBeenCalledWith(
      record.operationId,
      expect.objectContaining({ activate: true }),
    );
    expect(mocks.error.mock.calls[0][0]).toContain(
      'channels, schedules, hooks and restored sessions remain held',
    );
  });
  it('requires an explicit point and locator and refuses malformed input before AWS credentials', async () => {
    await expect(runRestoreCommand({ region: args.region, yes: true })).rejects.toThrow('--from');
    await expect(runRestoreCommand({ ...args, from: 'latest' })).rejects.toThrow('operation ID');
    expect(mocks.target).not.toHaveBeenCalled();
  });
  it('requires approval for noninteractive mutations and rejects a remaining source before approval', async () => {
    await expect(runRestoreCommand({ ...args, yes: false })).rejects.toThrow('--yes');
    expect(mocks.stage).not.toHaveBeenCalled();
    mocks.prepare.mockResolvedValueOnce({
      context,
      bootstrap: restoreJobFixture.bootstrap,
      sourcePresence: { kind: 'live' },
      prerequisites: [],
    });
    await expect(runRestoreCommand(args)).rejects.toThrow('source identity');
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it('inspects historical metadata without AWS calls and refuses mutable target overrides on resume', async () => {
    await runRestoreCommand({ action: 'inspect', operationId: record.operationId, json: true });
    expect(mocks.target).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.print.mock.calls[0][0]).recordedPhase).toBe('ready-inactive');
    await expect(
      runRestoreCommand({
        action: 'resume',
        operationId: record.operationId,
        region: 'us-east-1',
        yes: true,
      }),
    ).rejects.toThrow('recorded target');
  });
});
