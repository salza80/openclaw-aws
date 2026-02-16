import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

const spinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  text: '',
}));

vi.mock('ora', () => ({
  default: vi.fn(() => spinner),
}));

const buildCommandContextMock = vi.hoisted(() =>
  vi.fn(async () => ({
    name: 'alpha',
    config: {
      aws: { region: 'us-east-1' },
      stack: { name: 'OpenclawStack-alpha' },
      instance: { name: 'openclaw-alpha' },
    },
    awsEnv: { AWS_PROFILE: 'test' },
  })),
);

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

vi.mock('../../src/cli/utils/errors.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/cli/utils/errors.js')>(
    '../../src/cli/utils/errors.js',
  );
  return {
    ...actual,
    handleError: vi.fn(),
  };
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
        env: { AWS_PROFILE: 'test' },
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
