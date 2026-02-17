import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';

vi.mock('ora', async () => {
  const { createSpinnerMock } = await import('../helpers/mocks/spinner.js');
  return {
    default: vi.fn(() => createSpinnerMock()),
  };
});

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

const getInstanceStateMock = vi.hoisted(() => vi.fn());
const startInstanceMock = vi.hoisted(() => vi.fn());
const waitForInstanceStateMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/ec2.js', () => ({
  getInstanceState: getInstanceStateMock,
  startInstance: startInstanceMock,
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
import startCommand from '../../src/cli/commands/start.js';

type StartHandler = NonNullable<(typeof startCommand)['handler']>;
type StartHandlerArgs = Parameters<StartHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('start command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when instance is already running', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    getInstanceStateMock.mockResolvedValue('running');

    const handler = (startCommand as CommandModule).handler!;
    const args: StartHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(startInstanceMock).not.toHaveBeenCalled();
    expect(waitForInstanceStateMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('starts instance and waits for SSM readiness', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    getInstanceStateMock.mockResolvedValue('stopped');
    startInstanceMock.mockResolvedValue(undefined);
    waitForInstanceStateMock.mockResolvedValue(true);
    checkSSMStatusMock.mockResolvedValue(true);

    const handler = (startCommand as CommandModule).handler!;
    const args: StartHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(startInstanceMock).toHaveBeenCalledWith('i-123', 'us-east-1');
    expect(waitForInstanceStateMock).toHaveBeenCalledWith('i-123', 'us-east-1', 'running', 180000);
    expect(checkSSMStatusMock).toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });
});
