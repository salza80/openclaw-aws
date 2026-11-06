import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  query: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  inspect: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/operations/models.js', () => ({
  queryModels: mocks.query,
  prepareModelChange: mocks.prepare,
  applyModelChange: mocks.apply,
  inspectModelOperation: mocks.inspect,
}));
vi.mock('prompts', () => ({ default: mocks.prompt }));
import { runModelsCommand } from '../../src/cli/commands/models.js';
import { modelJob } from '../helpers/model-operation.js';
const ctx = {
  name: 'test',
  target: { account: modelJob.target.account, region: modelJob.target.region },
};
const plan = { job: modelJob, before: { effectiveForNewSessions: 'openrouter/old' } };
const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  mocks.context.mockResolvedValue(ctx);
  mocks.prepare.mockResolvedValue(plan);
  mocks.query.mockResolvedValue({ phase: 'observed' });
  mocks.apply.mockResolvedValue({ phase: 'complete', operationId: modelJob.operationId });
  mocks.inspect.mockResolvedValue({ phase: 'uncertain', maintenanceHeld: true, observed: null });
});
afterEach(() => {
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.restoreAllMocks();
});
describe('models CLI boundary', () => {
  it('targets Gateway defaults or one explicit existing agent through shared reads', async () => {
    await runModelsCommand({ action: 'current', name: 'test' });
    expect(mocks.query).toHaveBeenCalledWith(ctx, {
      scope: { kind: 'default' },
      action: { kind: 'current' },
    });
    await runModelsCommand({
      action: 'list',
      agent: 'researcher',
      provider: 'openrouter',
      offset: 20,
      limit: 5,
    });
    expect(mocks.query).toHaveBeenLastCalledWith(ctx, {
      scope: modelJob.scope,
      action: { kind: 'list', provider: 'openrouter', offset: 20, limit: 5 },
    });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });
  it('previews explicit scope/restart/operation and applies only the displayed plan after approval', async () => {
    await runModelsCommand({
      action: 'set',
      model: 'openrouter/new',
      name: 'test',
      agent: 'researcher',
      operationId: modelJob.operationId,
      allowRestart: true,
      yes: true,
      json: true,
    });
    expect(mocks.prepare).toHaveBeenCalledWith(ctx, {
      scope: modelJob.scope,
      model: 'openrouter/new',
      operationId: modelJob.operationId,
      allowRestart: true,
    });
    expect(mocks.apply).toHaveBeenCalledWith(ctx, plan);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(modelJob.operationId));
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      phase: 'complete',
    });
  });
  it('prints a concrete dry-run preview without applying or prompting', async () => {
    await runModelsCommand({ action: 'set', model: 'openrouter/new', dryRun: true });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual(plan);
  });
  it('refuses an unapproved noninteractive change and honors cancellation', async () => {
    await expect(runModelsCommand({ action: 'set', model: 'openrouter/new' })).rejects.toThrow(
      /--yes/,
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mocks.prompt.mockResolvedValue({ approved: false });
    await runModelsCommand({ action: 'set', model: 'openrouter/new' });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('shows uncertain reads without replay and requires explicit observed-state acceptance for reconciliation', async () => {
    await runModelsCommand({ action: 'inspect', operationId: modelJob.operationId });
    expect(mocks.inspect).toHaveBeenCalledWith(ctx, modelJob.operationId);
    await runModelsCommand({
      action: 'reconcile',
      operationId: modelJob.operationId,
      accept: 'requested',
      yes: true,
    });
    expect(mocks.inspect).toHaveBeenLastCalledWith(ctx, modelJob.operationId, {
      accept: 'requested',
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('reports an unsuccessful model write as a failure after returning its structured outcome', async () => {
    mocks.apply.mockResolvedValue({ phase: 'uncertain', operationId: modelJob.operationId });
    await expect(
      runModelsCommand({ action: 'set', model: 'openrouter/new', yes: true, json: true }),
    ).rejects.toThrow(/did not complete/);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      phase: 'uncertain',
    });
  });
  it.each([
    { action: 'current', agent: '' },
    { action: 'set' },
    { action: 'current', model: 'openrouter/new' },
    { action: 'list', allowRestart: true },
    { action: 'current', provider: 'openrouter' },
    { action: 'set', model: 'openrouter/new', accept: 'requested' as const },
    { action: 'inspect' },
    { action: 'inspect', operationId: modelJob.operationId, agent: 'researcher' },
    { action: 'reconcile', operationId: modelJob.operationId },
    { action: 'current', operationId: modelJob.operationId },
  ])(
    'rejects conflicting or ambiguous target arguments before AWS operations: %j',
    async (args) => {
      await expect(runModelsCommand(args)).rejects.toThrow();
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );
});
