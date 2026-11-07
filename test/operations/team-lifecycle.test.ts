import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  query: vi.fn(),
  archivePlan: vi.fn(),
  archive: vi.fn(),
  restorePlan: vi.fn(),
  stage: vi.fn(),
  resume: vi.fn(),
  record: vi.fn(),
  context: vi.fn(),
  source: vi.fn(),
  adopt: vi.fn(),
}));
vi.mock('../../src/operations/team-state.js', () => ({
  readTeamState: mocks.state,
  saveTeamIdentityState: mocks.adopt,
}));
vi.mock('../../src/operations/teams.js', () => ({ queryTeam: mocks.query }));
vi.mock('../../src/operations/archive.js', () => ({
  planArchive: mocks.archivePlan,
  createArchive: mocks.archive,
}));
vi.mock('../../src/operations/restore.js', () => ({
  prepareRestore: mocks.restorePlan,
  stageRestore: mocks.stage,
  resumeRestore: mocks.resume,
}));
vi.mock('../../src/operations/restore-record.js', () => ({ loadRestoreRecord: mocks.record }));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/operations/lock.js', () => ({
  withDeploymentLock: async (_ctx: unknown, run: () => unknown) => run(),
}));
import {
  prepareTeamArchive,
  prepareTeamRestore,
  stageTeamRestore,
} from '../../src/operations/team-lifecycle.js';
import { parseTeamDefinition, teamMembers } from '../../src/openclaw/team-definition.js';
import { teamIdentity } from '../../src/openclaw/team-recovery.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const ctx = makeCommandContext();
const id = '11111111-1111-1111-1111-111111111111';
const operationId = '22222222-2222-2222-2222-222222222222';
const definition = parseTeamDefinition({
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Coordinator', instructions: 'Coordinate.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research.' },
  ],
});
const members = teamMembers(definition, '/home/ubuntu', {
  id: 'main',
  workspace: '/home/ubuntu/.openclaw/workspace',
  agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
});
const team = { ...teamIdentity(id, definition), policyDigest: 'a'.repeat(64) };
const source = {
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/OpenclawStack-alpha/restored',
  instanceId: 'i-1234567890abcdef0',
  role: { id: 'AROATESTROLE00000001' },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.mockResolvedValue({ teamId: id, definition });
  mocks.query.mockResolvedValue({ members, pendingControl: null, maintenanceHeld: false });
  mocks.archivePlan.mockResolvedValue({ operationId });
  mocks.restorePlan.mockResolvedValue({
    operationId,
    point: { capture: { members, credentials: { team } } },
  });
  mocks.stage.mockResolvedValue({ operationId, name: ctx.name, phase: 'ready-inactive' });
  mocks.context.mockResolvedValue(ctx);
  mocks.source.mockResolvedValue(source);
});
describe('whole-host team archive and clean-client restore', () => {
  it('previews exactly one whole-host archive with the complete team roster', async () => {
    await prepareTeamArchive(ctx, { vaultUri: 's3://independent-vault/recovery' });
    expect(mocks.archivePlan).toHaveBeenCalledOnce();
    expect(mocks.archivePlan.mock.calls[0][1].expectedMembers).toEqual(members);
  });
  it('blocks unrelated co-hosted agents or unresolved maintenance before archive planning', async () => {
    mocks.query.mockResolvedValueOnce({
      members: [...members, { ...members[1], id: 'unrelated' }],
      pendingControl: null,
      maintenanceHeld: false,
    });
    await expect(
      prepareTeamArchive(ctx, { vaultUri: 's3://independent-vault/recovery' }),
    ).rejects.toThrow('complete native roster');
    mocks.query.mockResolvedValueOnce({
      members,
      pendingControl: operationId,
      maintenanceHeld: true,
    });
    await expect(
      prepareTeamArchive(ctx, { vaultUri: 's3://independent-vault/recovery' }),
    ).rejects.toThrow('pending host maintenance');
    expect(mocks.archivePlan).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('takes clean-client team mapping from the canonical saved point, then stages one target and adopts new ownership', async () => {
    const plan = await prepareTeamRestore({
      recoveryTarget: ctx.target,
      vaultUri: 's3://independent-vault/recovery',
      pointId: id,
    });
    await stageTeamRestore(plan, ctx.target);
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(mocks.adopt).toHaveBeenCalledWith(
      {
        deploymentName: ctx.name,
        stackId: source.stackId,
        instanceId: source.instanceId,
        roleId: source.role.id,
        account: ctx.target.account,
        region: ctx.target.region,
      },
      operationId,
      team,
    );
  });
  it('refuses absent or incomplete recovery role mappings before staging a host', async () => {
    mocks.restorePlan.mockResolvedValueOnce({
      operationId,
      point: { capture: { members, credentials: {} } },
    });
    await expect(
      prepareTeamRestore({
        recoveryTarget: ctx.target,
        vaultUri: 's3://independent-vault/recovery',
        pointId: id,
      }),
    ).rejects.toThrow('ownership metadata');
    mocks.restorePlan.mockResolvedValueOnce({
      operationId,
      point: {
        capture: {
          members: [...members, { ...members[1], id: 'unrelated' }],
          credentials: { team },
        },
      },
    });
    await expect(
      prepareTeamRestore({
        recoveryTarget: ctx.target,
        vaultUri: 's3://independent-vault/recovery',
        pointId: id,
      }),
    ).rejects.toThrow('complete native roster');
    expect(mocks.stage).not.toHaveBeenCalled();
  });
});
