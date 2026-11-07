import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  apply: vi.fn(),
  error: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('../../src/operations/instances.js', () => ({
  prepareInstancePower: mocks.prepare,
  applyInstancePower: mocks.apply,
}));
vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: async () => makeCommandContext(),
}));
vi.mock('../../src/cli/utils/errors.js', () => ({ handleError: mocks.error }));
vi.mock('../../src/cli/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));
vi.mock('prompts', () => ({ default: mocks.prompt }));
import command from '../../src/cli/commands/stop.js';
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.prepare.mockResolvedValue({
    before: 'running',
    target: { instanceId: 'i-approved', account: '123456789012', region: 'us-east-1' },
  });
  mocks.apply.mockResolvedValue({ state: 'stopped', changed: true, ssmReady: true });
});
describe('stop shared-operation CLI', () => {
  it('delegates to the same application plan and apply functions as the local UI', async () => {
    await command.handler?.({ _: [], $0: 'claw', force: true });
    expect(mocks.prepare).toHaveBeenCalledWith(makeCommandContext(), 'stop');
    expect(mocks.apply).toHaveBeenCalledWith(
      makeCommandContext(),
      mocks.prepare.mock.results[0].value ? await mocks.prepare.mock.results[0].value : undefined,
      expect.any(Object),
    );
  });
  it('reports a failed plan without sending a power operation', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('owned deployment lock'));
    await command.handler?.({ _: [], $0: 'claw' });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });
  it('requires confirmation before stopping and leaves cancellation without a power write', async () => {
    mocks.prompt.mockResolvedValueOnce({ confirm: false });
    await command.handler?.({ _: [], $0: 'claw' });
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.prompt.mockResolvedValueOnce({ confirm: true });
    await command.handler?.({ _: [], $0: 'claw' });
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
});
