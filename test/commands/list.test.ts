import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const listConfigNamesMock = vi.hoisted(() => vi.fn());
const getCurrentNameMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/config-store.js', () => ({
  listConfigNames: listConfigNamesMock,
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
import listCommand from '../../src/cli/commands/list.js';

type ListHandler = NonNullable<(typeof listCommand)['handler']>;
type ListHandlerArgs = Parameters<ListHandler>[0];

describe('list command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints guidance when there are no configs', async () => {
    listConfigNamesMock.mockReturnValue([]);
    getCurrentNameMock.mockReturnValue(null);

    const handler = (listCommand as CommandModule).handler!;
    const args = {} as ListHandlerArgs;
    await handler(args);

    expect(logger.info).toHaveBeenCalledWith('No configs found');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws init --name <name>');
  });

  it('lists configs and marks the current one', async () => {
    listConfigNamesMock.mockReturnValue(['alpha', 'beta']);
    getCurrentNameMock.mockReturnValue('beta');

    const handler = (listCommand as CommandModule).handler!;
    const args = {} as ListHandlerArgs;
    await handler(args);

    expect(logger.title).toHaveBeenCalledWith('OpenClaw AWS - Configs');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    expect(output).toContain('current');
  });
});
