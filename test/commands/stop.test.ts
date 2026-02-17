import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';

vi.mock('ora', async () => {
  const { createSpinnerMock } = await import('../helpers/mocks/spinner.js');
  return {
    default: vi.fn(() => createSpinnerMock()),
  };
});

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({
  default: promptsMock,
}));

const buildCommandContextMock = vi.hoisted(() => vi.fn());
buildCommandContextMock.mockImplementation(async () => makeCommandContext());

vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: buildCommandContextMock,
}));

const resolveInstanceIdMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws.js', () => ({
  resolveInstanceId: resolveInstanceIdMock,
}));

const getInstanceStateMock = vi.hoisted(() => vi.fn());
const stopInstanceMock = vi.hoisted(() => vi.fn());
const waitForInstanceStateMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/ec2.js', () => ({
  getInstanceState: getInstanceStateMock,
  stopInstance: stopInstanceMock,
  waitForInstanceState: waitForInstanceStateMock,
}));

vi.mock('../../src/cli/utils/logger.js', async () => {
  const { createLoggerMock } = await import('../helpers/mocks/logger.js');
  return {
    logger: createLoggerMock(),
  };
});

vi.mock('../../src/cli/utils/errors.js', async () => {
  const { createErrorsModuleMock } = await import('../helpers/mocks/errors.js');
  return createErrorsModuleMock({ handleError: vi.fn() });
});

import { handleError } from '../../src/cli/utils/errors.js';
import stopCommand from '../../src/cli/commands/stop.js';

type StopHandler = NonNullable<(typeof stopCommand)['handler']>;
type StopHandlerArgs = Parameters<StopHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('stop command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when instance is already stopped', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    getInstanceStateMock.mockResolvedValue('stopped');

    const handler = (stopCommand as CommandModule).handler!;
    const args: StopHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(stopInstanceMock).not.toHaveBeenCalled();
    expect(waitForInstanceStateMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('stops instance when force is true', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    getInstanceStateMock.mockResolvedValue('running');
    stopInstanceMock.mockResolvedValue(undefined);
    waitForInstanceStateMock.mockResolvedValue(true);

    const handler = (stopCommand as CommandModule).handler!;
    const args: StopHandlerArgs = { force: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(promptsMock).not.toHaveBeenCalled();
    expect(stopInstanceMock).toHaveBeenCalledWith('i-123', 'us-east-1');
    expect(waitForInstanceStateMock).toHaveBeenCalledWith('i-123', 'us-east-1', 'stopped', 120000);
    expect(handleErrorMock).not.toHaveBeenCalled();
  });
});
