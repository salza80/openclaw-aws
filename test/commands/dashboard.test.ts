import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  stop: vi.fn(),
  open: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../src/operations/native-dashboard.js', () => ({
  prepareNativeDashboard: mocks.prepare,
}));
vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: async () => ({ name: 'alpha' }),
}));
vi.mock('../../src/cli/utils/errors.js', () => ({ handleError: mocks.error }));
vi.mock('../../src/cli/utils/logger.js', () => ({ logger: { info: vi.fn() } }));
import command from '../../src/cli/commands/dashboard.js';
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.prepare.mockResolvedValue({
    publicUrl: 'http://localhost:19444',
    browserUrl: (privateUrl: boolean) =>
      privateUrl ? 'http://localhost:19444/#token=private-fixture' : 'http://localhost:19444',
    stop: mocks.stop,
    open: mocks.open,
    done: Promise.resolve(),
  });
});
describe('native dashboard CLI handoff', () => {
  it('prints only the public URL by default and opens the native UI through the shared operation', async () => {
    await command.handler?.({ _: [], $0: 'claw' });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('private-fixture'));
  });
  it('permits only deliberate --show-token output and honors --no-open', async () => {
    await command.handler?.({ _: [], $0: 'claw', showToken: true, open: false });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('private-fixture'));
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it('reports unready targets without inventing a usable tunnel', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('Gateway unavailable'));
    await command.handler?.({ _: [], $0: 'claw' });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });
});
