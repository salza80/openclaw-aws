import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

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
const waitForSSMMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/aws.js', () => ({
  resolveInstanceId: resolveInstanceIdMock,
  checkSSMStatus: checkSSMStatusMock,
  waitForSSM: waitForSSMMock,
}));

vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  validateSSMPlugin: vi.fn(async () => {}),
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

import { AWSError, handleError } from '../../src/cli/utils/errors.js';
import connectCommand from '../../src/cli/commands/connect.js';

type ConnectHandler = NonNullable<(typeof connectCommand)['handler']>;
type ConnectHandlerArgs = Parameters<ConnectHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('connect command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('connects when SSM is ready', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    checkSSMStatusMock.mockResolvedValue(true);
    execaMock.mockResolvedValue({});

    const handler = (connectCommand as CommandModule).handler!;
    const args: ConnectHandlerArgs = { name: 'alpha', _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(buildCommandContextMock).toHaveBeenCalledWith({ name: 'alpha' });
    expect(waitForSSMMock).not.toHaveBeenCalled();
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      'aws',
      [
        'ssm',
        'start-session',
        '--target',
        'i-123',
        '--region',
        'us-east-1',
        '--document-name',
        'AWS-StartInteractiveCommand',
        '--parameters',
        'command="sudo su - ubuntu"',
      ],
      {
        stdio: 'inherit',
        env: expect.objectContaining({ AWS_PROFILE: 'test' }),
      },
    );
  });

  it('waits for SSM when not ready, then connects', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    checkSSMStatusMock.mockResolvedValue(false);
    waitForSSMMock.mockResolvedValue(true);
    execaMock.mockResolvedValue({});

    const handler = (connectCommand as CommandModule).handler!;
    const args: ConnectHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(waitForSSMMock).toHaveBeenCalledWith('i-123', 'us-east-1', 180000, 10000);
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it('calls handleError when SSM never becomes ready', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    checkSSMStatusMock.mockResolvedValue(false);
    waitForSSMMock.mockResolvedValue(false);

    const handler = (connectCommand as CommandModule).handler!;
    const args: ConnectHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).not.toHaveBeenCalled();
    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    const [error] = handleErrorMock.mock.calls[0];
    expect(error).toBeInstanceOf(AWSError);
    expect((error as AWSError).message).toContain('Instance not ready for SSM connection');
  });
});
