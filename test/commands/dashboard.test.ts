import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
const checkGatewayStatusMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/aws.js', () => ({
  resolveInstanceId: resolveInstanceIdMock,
  checkSSMStatus: checkSSMStatusMock,
  checkGatewayStatus: checkGatewayStatusMock,
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

const loadOutputsByNameMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config.js', () => ({
  loadOutputsByName: loadOutputsByNameMock,
}));

const createSsmClientMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: createSsmClientMock,
}));

vi.mock('@aws-sdk/client-ssm', async () => {
  const { createAwsCommandClass } = await import('../helpers/mocks/aws-commands.js');
  return {
    GetParameterCommand: createAwsCommandClass<{ Name: string; WithDecryption: boolean }>(),
  };
});

vi.mock('../../src/cli/utils/errors.js', async () => {
  const { createErrorsModuleMock } = await import('../helpers/mocks/errors.js');
  return createErrorsModuleMock({ handleError: vi.fn() });
});

import { AWSError, handleError } from '../../src/cli/utils/errors.js';
import dashboardCommand from '../../src/cli/commands/dashboard.js';

type DashboardHandler = NonNullable<(typeof dashboardCommand)['handler']>;
type DashboardHandlerArgs = Parameters<DashboardHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('dashboard command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('starts port forwarding when ready and noOpen is true', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    checkSSMStatusMock.mockResolvedValue(true);
    checkGatewayStatusMock.mockResolvedValue({ running: true });
    loadOutputsByNameMock.mockReturnValue({
      'OpenclawStack-alpha': { GatewayToken: 'token-123', GatewayPort: '18789' },
    });
    createSsmClientMock.mockReturnValue({
      send: vi.fn(),
      destroy: vi.fn(),
    });

    const portForward = Object.assign(Promise.resolve(undefined), { kill: vi.fn() });
    execaMock.mockReturnValue(portForward);

    const handler = (dashboardCommand as CommandModule).handler!;
    const args: DashboardHandlerArgs = { noOpen: true, _: [], $0: 'openclaw-aws' };
    const run = handler(args);
    await vi.runAllTimersAsync();
    await run;

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      'aws',
      [
        'ssm',
        'start-session',
        '--target',
        'i-123',
        '--document-name',
        'AWS-StartPortForwardingSession',
        '--parameters',
        JSON.stringify({
          portNumber: ['18789'],
          localPortNumber: ['18789'],
        }),
        '--region',
        'us-east-1',
      ],
      {
        env: expect.objectContaining({ AWS_PROFILE: 'test' }),
        stdio: 'inherit',
      },
    );
    expect(createSsmClientMock).not.toHaveBeenCalled();
  });

  it('calls handleError when SSM is not ready', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    checkSSMStatusMock.mockResolvedValue(false);
    checkGatewayStatusMock.mockResolvedValue({ running: true });

    const handler = (dashboardCommand as CommandModule).handler!;
    const args: DashboardHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    const [error] = handleErrorMock.mock.calls[0];
    expect(error).toBeInstanceOf(AWSError);
    expect((error as AWSError).message).toContain('Instance not ready for SSM connection');
  });

  it('calls handleError when gateway is not running', async () => {
    resolveInstanceIdMock.mockResolvedValue('i-123');
    checkSSMStatusMock.mockResolvedValue(true);
    checkGatewayStatusMock.mockResolvedValue({ running: false });

    const handler = (dashboardCommand as CommandModule).handler!;
    const args: DashboardHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    const [error] = handleErrorMock.mock.calls[0];
    expect(error).toBeInstanceOf(AWSError);
    expect((error as AWSError).message).toContain('OpenClaw gateway is not running');
  });
});
