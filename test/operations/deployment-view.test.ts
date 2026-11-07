import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  names: vi.fn(),
  config: vi.fn(),
  context: vi.fn(),
  stack: vi.fn(),
  ssm: vi.fn(),
  gateway: vi.fn(),
  saved: vi.fn(),
  observe: vi.fn(),
  record: vi.fn(),
  team: vi.fn(),
  teamQuery: vi.fn(),
}));
vi.mock('../../src/cli/utils/config-store.js', () => ({ listConfigNames: mocks.names }));
vi.mock('../../src/cli/utils/config.js', () => ({ loadConfigByName: mocks.config }));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: mocks.stack,
  getSSMStatus: mocks.ssm,
  checkGatewayStatus: mocks.gateway,
}));
vi.mock('../../src/operations/state.js', () => ({
  assertDeploymentTarget: vi.fn(),
  loadDeploymentState: mocks.saved,
  observeRuntime: mocks.observe,
  recordDeploymentState: mocks.record,
}));
vi.mock('../../src/operations/team-state.js', () => ({ readTeamState: mocks.team }));
vi.mock('../../src/operations/teams.js', () => ({ queryTeam: mocks.teamQuery }));
import { listDeploymentViews } from '../../src/operations/deployment-view.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.names.mockReturnValue(['alpha']);
  mocks.config.mockReturnValue({ aws: { region: 'eu-central-1', profile: 'fixture' } });
  mocks.context.mockResolvedValue({
    name: 'alpha',
    config: { stack: { name: 'OpenclawStack-alpha' } },
    target: { account: '123456789012', region: 'eu-central-1' },
  });
  mocks.team.mockRejectedValue(new Error('Absent'));
  mocks.stack.mockResolvedValue({
    stackStatus: 'CREATE_COMPLETE',
    instanceId: 'i-0123456789abcdef0',
    instanceStatus: 'stopped',
  });
});
describe('timestamped deployment views', () => {
  it('distinguishes stopped, missing and unreachable without claiming healthy/idle', async () => {
    expect((await listDeploymentViews())[0]).toMatchObject({
      state: 'stopped',
      gateway: { healthy: null, checkedAt: null },
    });
    mocks.stack.mockRejectedValue(new StackNotFoundError('alpha', 'eu-central-1'));
    expect((await listDeploymentViews())[0].state).toBe('missing');
    mocks.stack.mockRejectedValue(new Error('AWS read failed'));
    expect((await listDeploymentViews())[0].state).toBe('unreachable');
  });
  it('keeps saved runtime metadata when a live observation fails', async () => {
    mocks.saved.mockReturnValue({
      desired: { version: '2026.11.1' },
      observed: { version: '2026.10.1', checkedAt: '2026-11-01T00:00:00Z' },
    });
    mocks.stack.mockRejectedValue(new Error('Unavailable'));
    expect((await listDeploymentViews())[0].runtime).toEqual({
      expected: '2026.11.1',
      observed: '2026.10.1',
      checkedAt: '2026-11-01T00:00:00Z',
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('groups coordinator/researcher/reviewer under one hosting view', async () => {
    mocks.team.mockResolvedValue({
      teamId: 'team',
      definition: {
        coordinator: 'lead',
        members: [
          { id: 'lead', role: 'Coordinator' },
          { id: 'researcher', role: 'Research' },
          { id: 'reviewer', role: 'Review' },
        ],
      },
    });
    const views = await listDeploymentViews();
    expect(views).toHaveLength(1);
    expect(views[0].team).toMatchObject({
      observed: false,
      members: [{ id: 'main' }, { id: 'researcher' }, { id: 'reviewer' }],
    });
  });
  it('isolates one unreadable configuration rather than hiding every host', async () => {
    mocks.names.mockReturnValue(['bad', 'alpha']);
    mocks.config.mockImplementation((name) => {
      if (name === 'bad') throw new Error('Invalid config');
      return { aws: { region: 'eu-central-1' } };
    });
    expect((await listDeploymentViews()).map((view) => view.state)).toEqual([
      'unreachable',
      'stopped',
    ]);
  });
});
