import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const spinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  warn: vi.fn().mockReturnThis(),
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
    awsEnv: {},
  })),
);

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
