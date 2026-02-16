import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const getCurrentNameMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config-store.js', () => ({
  getCurrentName: getCurrentNameMock,
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
import currentCommand from '../../src/cli/commands/current.js';

type CurrentHandler = NonNullable<(typeof currentCommand)['handler']>;
type CurrentHandlerArgs = Parameters<CurrentHandler>[0];

describe('current command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows guidance when no current config is set', async () => {
    getCurrentNameMock.mockReturnValue(null);

    const handler = (currentCommand as CommandModule).handler!;
    const args = {} as CurrentHandlerArgs;
    await handler(args);

    expect(logger.info).toHaveBeenCalledWith('No current config selected');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws use <name>');
  });

  it('logs the current config when present', async () => {
    getCurrentNameMock.mockReturnValue('alpha');

    const handler = (currentCommand as CommandModule).handler!;
    const args = {} as CurrentHandlerArgs;
    await handler(args);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('alpha'));
  });
});
