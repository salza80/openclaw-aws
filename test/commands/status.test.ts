import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const spinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  warn: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
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
      instance: { name: 'openclaw-alpha', type: 't3.micro' },
    },
    awsEnv: {},
  })),
);

vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: buildCommandContextMock,
}));

const listConfigNamesMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config-store.js', () => ({
  listConfigNames: listConfigNamesMock,
}));

const getStackStatusMock = vi.hoisted(() => vi.fn());
const getSSMStatusMock = vi.hoisted(() => vi.fn());
const checkGatewayStatusMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: getStackStatusMock,
  getSSMStatus: getSSMStatusMock,
  checkGatewayStatus: checkGatewayStatusMock,
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
    withRetry: async <T>(operation: () => Promise<T>) => operation(),
  };
});

import { handleError } from '../../src/cli/utils/errors.js';
import statusCommand, {
  formatGatewayStatus,
  formatInstanceStatus,
  formatSSMStatus,
  formatStackStatus,
} from '../../src/cli/commands/status.js';
import { logger } from '../../src/cli/utils/logger.js';

type StatusHandler = NonNullable<(typeof statusCommand)['handler']>;
type StatusHandlerArgs = Parameters<StatusHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('status command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints guidance when --all has no configs', async () => {
    listConfigNamesMock.mockReturnValue([]);

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(logger.info).toHaveBeenCalledWith('No configs found');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws init --name <name>');
  });

  it('shows details for --all when stack exists and gateway is running', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
      instanceStatus: 'running',
      ssmStatus: 'ready',
      instanceId: 'i-123',
    });
    getSSMStatusMock.mockResolvedValue({ status: 'Online' });
    checkGatewayStatusMock.mockResolvedValue({ running: true });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(getStackStatusMock).toHaveBeenCalled();
    expect(getSSMStatusMock).toHaveBeenCalled();
    expect(checkGatewayStatusMock).toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('prints guidance when deployment not found', async () => {
    getStackStatusMock.mockRejectedValue(new Error('stack not found'));

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(handleErrorMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('No deployment found');
  });
});

describe('status formatters', () => {
  it('formats stack status', () => {
    expect(formatStackStatus('CREATE_COMPLETE')).toContain('CREATE_COMPLETE');
    expect(formatStackStatus('UPDATE_FAILED')).toContain('UPDATE_FAILED');
    expect(formatStackStatus('UPDATE_IN_PROGRESS')).toContain('UPDATE_IN_PROGRESS');
  });

  it('formats instance status', () => {
    expect(formatInstanceStatus('running')).toContain('Running');
    expect(formatInstanceStatus('stopped')).toContain('Stopped');
    expect(formatInstanceStatus('pending')).toContain('Starting');
  });

  it('formats ssm status', () => {
    expect(formatSSMStatus('ready')).toContain('Ready');
    expect(formatSSMStatus('not-ready')).toContain('Not Ready');
  });

  it('formats gateway status', () => {
    expect(formatGatewayStatus(true)).toContain('Running');
    expect(formatGatewayStatus(false)).toContain('Not Running');
    expect(formatGatewayStatus(false, 'boom')).toContain('boom');
  });
});
