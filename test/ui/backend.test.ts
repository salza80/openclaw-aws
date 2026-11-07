import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  source: vi.fn(),
  powerPreview: vi.fn(),
  powerApply: vi.fn(),
  backup: vi.fn(),
  list: vi.fn(),
  archiveInspect: vi.fn(),
  restorePreview: vi.fn(),
  restoreStage: vi.fn(),
  teamRestoreStage: vi.fn(),
  teamState: vi.fn(),
  teamPreview: vi.fn(),
  modelPreview: vi.fn(),
  modelApply: vi.fn(),
  modelQuery: vi.fn(),
  native: vi.fn(),
  target: vi.fn(),
}));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/aws/target.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAwsTarget: mocks.target,
}));
vi.mock('../../src/aws/recovery-source.js', async (importOriginal) => ({
  ...(await importOriginal()),
  inspectRecoverySource: mocks.source,
}));
vi.mock('../../src/operations/instances.js', () => ({
  prepareInstancePower: mocks.powerPreview,
  applyInstancePower: mocks.powerApply,
}));
vi.mock('../../src/operations/backup.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createBackup: mocks.backup,
  listBackups: mocks.list,
}));
vi.mock('../../src/operations/archive.js', async (importOriginal) => ({
  ...(await importOriginal()),
  inspectArchive: mocks.archiveInspect,
}));
vi.mock('../../src/operations/restore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareRestore: mocks.restorePreview,
  stageRestore: mocks.restoreStage,
}));
vi.mock('../../src/operations/team-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stageTeamRestore: mocks.teamRestoreStage,
}));
vi.mock('../../src/operations/team-state.js', () => ({ readTeamState: mocks.teamState }));
vi.mock('../../src/operations/teams.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareTeam: mocks.teamPreview,
}));
vi.mock('../../src/operations/models.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareModelChange: mocks.modelPreview,
  applyModelChange: mocks.modelApply,
  queryModels: mocks.modelQuery,
}));
vi.mock('../../src/operations/native-dashboard.js', () => ({
  prepareNativeDashboard: mocks.native,
}));
import { createUiBackend } from '../../src/ui/backend.js';
import { parseUiPlanView } from '../../src/ui/public.js';
import { modelJob } from '../helpers/model-operation.js';
import { nativeModelAction } from '../../src/openclaw/model-contract.js';
const id = 'a1000000-0000-4000-8000-000000000001';
const target = { account: '123456789012', region: 'eu-central-1', profile: 'fixture' };
const source = {
  stackId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-alpha/old',
  stackName: 'OpenclawStack-alpha',
  instanceId: 'i-0123456789abcdef0',
  role: { id: 'ROLE-ORIGINAL' },
  instance: { minimumDiskGiB: 30 },
};
const ctx = {
  name: 'alpha',
  target,
  config: { instance: { type: 't3a.small' } },
  awsEnv: { AWS_SECRET_ACCESS_KEY: 'PRIVATE-AWS-CREDENTIAL' },
};
const point = {
  id,
  completedAt: '2026-11-07T00:00:00Z',
  source,
  job: {},
  capture: { credentials: {}, gateway: {}, members: [{ id: 'main', model: 'openrouter/example' }] },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue(ctx);
  mocks.target.mockResolvedValue(target);
  mocks.source.mockResolvedValue(source);
  mocks.teamState.mockRejectedValue(Object.assign(new Error('Absent'), { code: 'ENOENT' }));
});
describe('UI application adapter', () => {
  it('paginates the policy-filtered native catalog within its actual page limit', async () => {
    mocks.modelQuery.mockImplementation(async (_ctx, { action }) => {
      nativeModelAction(action);
      if (action.kind === 'current') return { effectiveForNewSessions: 'openrouter/example' };
      return action.offset === 0
        ? { models: [{ model: 'openrouter/example', available: true }], nextOffset: 1 }
        : { models: [{ model: 'openrouter/other' }], nextOffset: null };
    });
    expect(await createUiBackend().models('alpha', 'researcher')).toEqual({
      current: 'openrouter/example',
      models: [
        { id: 'openrouter/example', available: true },
        { id: 'openrouter/other', available: null },
      ],
    });
    expect(mocks.modelQuery).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        scope: { kind: 'agent', agentId: 'researcher' },
        action: { kind: 'list', offset: 1, limit: 50 },
      }),
    );
  });
  it('uses the shared immutable power plan and never serializes the private context', async () => {
    const plan = {
      action: 'stop',
      before: 'running',
      target: {
        ...modelJob.target,
        deploymentName: 'alpha',
        account: target.account,
        region: target.region,
      },
    };
    mocks.powerPreview.mockResolvedValue(plan);
    mocks.powerApply.mockResolvedValue({
      state: 'stopped',
      ssmReady: null,
      checkedAt: '2026-11-07T00:00:00Z',
    });
    const operation = await createUiBackend().prepare({ action: 'stop', name: 'alpha' }, id);
    expect(parseUiPlanView(operation.view).target.name).toBe('alpha');
    expect(JSON.stringify(operation.view)).not.toContain('PRIVATE-AWS');
    expect(mocks.powerApply).not.toHaveBeenCalled();
    await operation.apply(() => {});
    expect(mocks.powerApply).toHaveBeenCalledWith(
      ctx,
      plan,
      expect.objectContaining({ progress: expect.any(Function) }),
    );
  });
  it('binds a backup to the preview source before capture', async () => {
    const operation = await createUiBackend().prepare(
      { action: 'backup', name: 'alpha', vault: 's3://fixture-vault/backups' },
      id,
    );
    mocks.backup.mockResolvedValue({ id, completedAt: point.completedAt });
    await operation.apply(() => {});
    expect(mocks.backup).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        expectedSource: {
          stackId: source.stackId,
          instanceId: source.instanceId,
          roleId: source.role.id,
        },
      }),
    );
  });
  it('restores archived team data without a source/local context and leaves activation separate', async () => {
    const team = {
      id,
      coordinator: 'lead',
      roles: [{ logicalId: 'lead', nativeId: 'main', role: 'Coordinator' }],
    };
    const plan = {
      context: ctx,
      point: { ...point, capture: { ...point.capture, credentials: { team } } },
      bootstrap: { volumeGiB: 32 },
      sourcePresence: { kind: 'gone' },
    };
    mocks.restorePreview.mockResolvedValue(plan);
    mocks.teamRestoreStage.mockResolvedValue({ phase: 'ready-inactive' });
    const operation = await createUiBackend().prepare(
      {
        action: 'restore',
        name: 'alpha',
        vault: 's3://fixture-vault/backups',
        from: id,
        region: target.region,
      },
      id,
    );
    expect(mocks.context).not.toHaveBeenCalled();
    expect(JSON.stringify(parseUiPlanView(operation.view))).not.toContain('PRIVATE-AWS');
    const result = await operation.apply(() => {});
    expect(mocks.teamRestoreStage).toHaveBeenCalledWith(
      { ...plan, team },
      target,
      expect.any(Object),
    );
    expect(result.recovery?.[0]).toMatchObject({
      action: 'resume',
      recoveryKind: 'restore',
      operationId: id,
      activate: true,
    });
    expect(mocks.restoreStage).not.toHaveBeenCalled();
  });
  it('does not infer destroyed compute from a held archive backup', async () => {
    mocks.list.mockResolvedValue([
      { ...point, capture: { ...point.capture, gateway: { held: { kind: 'archive' } } } },
    ]);
    mocks.archiveInspect.mockResolvedValue({ recordedPhase: 'unconfirmed' });
    const backend = createUiBackend();
    const reference = { uri: 's3://fixture-vault/backups', region: target.region };
    expect((await backend.recovery(reference))[0].state).toBe('backup');
    mocks.archiveInspect.mockResolvedValue({ recordedPhase: 'archived' });
    expect((await backend.recovery(reference))[0].state).toBe('archived');
  });
  it('makes unknown model writes require inspection rather than reporting success', async () => {
    mocks.modelPreview.mockResolvedValue({ before: { effectiveForNewSessions: 'openrouter/old' } });
    mocks.modelApply.mockResolvedValue({ phase: 'uncertain' });
    const operation = await createUiBackend().prepare(
      { action: 'model-set', name: 'alpha', model: 'openrouter/new' },
      id,
    );
    expect(parseUiPlanView(operation.view).recovery?.[0]).toMatchObject({
      operationId: id,
      recoveryKind: 'model',
    });
    await expect(operation.apply(() => {})).rejects.toThrow('inspection');
  });
});
