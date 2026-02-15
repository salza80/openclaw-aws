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

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({
  default: promptsMock,
}));

const buildCommandContextMock = vi.hoisted(() => vi.fn(async () => ({
  name: 'alpha',
  config: {
    aws: { region: 'us-east-1' },
    stack: { name: 'OpenclawStack-alpha' },
    instance: { name: 'openclaw-alpha' },
  },
  awsEnv: {},
})));

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
