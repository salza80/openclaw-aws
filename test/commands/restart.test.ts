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
const checkSSMStatusMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/aws.js', () => ({
  resolveInstanceId: resolveInstanceIdMock,
  checkSSMStatus: checkSSMStatusMock,
}));

const rebootInstanceMock = vi.hoisted(() => vi.fn());
const waitForInstanceStateMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/ec2.js', () => ({
  rebootInstance: rebootInstanceMock,
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
import restartCommand from '../../src/cli/commands/restart.js';

type RestartHandler = NonNullable<(typeof restartCommand)['handler']>;
type RestartHandlerArgs = Parameters<RestartHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('restart command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when confirm is false', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    promptsMock.mockResolvedValue({ confirm: false });

    const handler = (restartCommand as CommandModule).handler!;
    const args: RestartHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(rebootInstanceMock).not.toHaveBeenCalled();
    expect(waitForInstanceStateMock).not.toHaveBeenCalled();
  });

  it('reboots and waits for SSM when force is true', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    waitForInstanceStateMock.mockResolvedValue(true);
    checkSSMStatusMock.mockResolvedValue(true);

    vi.useFakeTimers();

    const handler = (restartCommand as CommandModule).handler!;
    const args: RestartHandlerArgs = { force: true, _: [], $0: 'openclaw-aws' };
    const run = handler(args);
    await vi.runAllTimersAsync();
    await run;

    vi.useRealTimers();

    expect(rebootInstanceMock).toHaveBeenCalledWith('i-123', 'us-east-1');
    expect(waitForInstanceStateMock).toHaveBeenCalledWith('i-123', 'us-east-1', 'running', 180000);
    expect(checkSSMStatusMock).toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });
});
