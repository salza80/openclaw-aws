import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const listConfigNamesMock = vi.hoisted(() => vi.fn());
const setCurrentNameMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/config-store.js', () => ({
  listConfigNames: listConfigNamesMock,
  setCurrentName: setCurrentNameMock,
}));

vi.mock('../../src/cli/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    title: vi.fn(),
    box: vi.fn(),
  },
}));

import { logger } from '../../src/cli/utils/logger.js';
import useCommand from '../../src/cli/commands/use.js';

type UseHandler = NonNullable<(typeof useCommand)['handler']>;
type UseHandlerArgs = Parameters<UseHandler>[0];

describe('use command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints guidance when config does not exist', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);

    const handler = (useCommand as CommandModule).handler!;
    const args = { name: 'beta' } as UseHandlerArgs;
    await handler(args);

    expect(logger.error).toHaveBeenCalledWith('Config not found: beta');
    expect(setCurrentNameMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws init --name beta');
  });

  it('sets current config when name exists', async () => {
    listConfigNamesMock.mockReturnValue(['alpha', 'beta']);

    const handler = (useCommand as CommandModule).handler!;
    const args = { name: 'beta' } as UseHandlerArgs;
    await handler(args);

    expect(setCurrentNameMock).toHaveBeenCalledWith('beta');
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('beta'));
  });
});
