import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';

const spinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  warn: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  text: '',
}));
vi.mock('ora', () => ({
  default: vi.fn(() => spinner),
}));

const buildCommandContextMock = vi.hoisted(() => vi.fn());
buildCommandContextMock.mockImplementation(async () => makeCommandContext());

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

vi.mock('../../src/cli/utils/logger.js', async () => {
  const { createLoggerMock } = await import('../helpers/mocks/logger.js');
  return {
    logger: createLoggerMock(),
  };
});

vi.mock('../../src/cli/utils/errors.js', async () =>
  (await import('../helpers/mocks/errors.js')).createErrorsModuleMock({
    handleError: vi.fn(),
    withRetry: (await import('../helpers/mocks/errors.js')).passthroughWithRetry,
  }),
);

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

  it('registers status command options', () => {
    const option = vi.fn().mockReturnThis();
    const yargsLike = { option } as unknown as Parameters<
      NonNullable<typeof statusCommand.builder>
    >[0];

    statusCommand.builder?.(yargsLike);

    expect(option).toHaveBeenCalledWith(
      'all',
      expect.objectContaining({ type: 'boolean', default: false }),
    );
    expect(option).toHaveBeenCalledWith(
      'name',
      expect.objectContaining({ type: 'string' }),
    );
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

  it('shows unknown details in --all when instance and ssm data are missing', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
    });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('unknown');
    expect(output).toContain('Region:');
    expect(output).toContain('Type:');
    expect(getSSMStatusMock).not.toHaveBeenCalled();
    expect(checkGatewayStatusMock).not.toHaveBeenCalled();
  });

  it('shows unknown gateway in --all when SSM is not online', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
      instanceStatus: 'running',
      ssmStatus: 'ready',
      instanceId: 'i-123',
    });
    getSSMStatusMock.mockResolvedValue({ status: 'ConnectionLost' });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(checkGatewayStatusMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Unknown');
  });

  it('shows not deployed details in --all when stack check fails', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    getStackStatusMock.mockRejectedValue(new Error('boom'));

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(spinner.warn).toHaveBeenCalledWith('alpha: not deployed');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Instance Type:');
  });

  it('shows full running status with gateway error and running quick commands', async () => {
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
      instanceStatus: 'running',
      ssmStatus: 'ready',
      instanceId: 'i-123',
    });
    getSSMStatusMock.mockResolvedValue({ status: 'Online' });
    checkGatewayStatusMock.mockResolvedValue({ running: false, error: 'gateway failed' });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(logger.title).toHaveBeenCalledWith('OpenClaw AWS - Deployment Status');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('OpenClaw Gateway:');
    expect(output).toContain('gateway failed');
    expect(output).toContain('openclaw-aws connect');
    expect(output).toContain('openclaw-aws dashboard');
    expect(output).toContain('openclaw-aws restart');
    expect(output).toContain('openclaw-aws destroy');
  });

  it('shows connection-lost details and unknown gateway when SSM is not connected', async () => {
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
      instanceStatus: 'running',
      ssmStatus: 'ready',
      instanceId: 'i-123',
    });
    getSSMStatusMock.mockResolvedValue({ status: 'ConnectionLost', lastPing: '2026-02-17T00:00:00.000Z' });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Connection Lost');
    expect(output).toContain('SSM not connected');
    expect(checkGatewayStatusMock).not.toHaveBeenCalled();
  });

  it('shows stopped quick commands', async () => {
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
      instanceStatus: 'stopped',
      ssmStatus: 'not-ready',
      instanceId: 'i-123',
    });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws start');
    expect(output).toContain('openclaw-aws destroy');
    expect(output).not.toContain('openclaw-aws restart');
  });

  it('shows generic quick command when instance status is unavailable', async () => {
    getStackStatusMock.mockResolvedValue({
      stackStatus: 'CREATE_COMPLETE',
    });

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws status');
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

  it('delegates unexpected errors to handleError', async () => {
    getStackStatusMock.mockRejectedValue(new Error('boom'));

    const handler = (statusCommand as CommandModule).handler!;
    const args: StatusHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(handleErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('status formatters', () => {
  it('formats stack status', () => {
    expect(formatStackStatus('CREATE_COMPLETE')).toContain('CREATE_COMPLETE');
    expect(formatStackStatus('UPDATE_FAILED')).toContain('UPDATE_FAILED');
    expect(formatStackStatus('UPDATE_IN_PROGRESS')).toContain('UPDATE_IN_PROGRESS');
    expect(formatStackStatus('UNKNOWN')).toContain('UNKNOWN');
  });

  it('formats instance status', () => {
    expect(formatInstanceStatus('running')).toContain('Running');
    expect(formatInstanceStatus('stopped')).toContain('Stopped');
    expect(formatInstanceStatus('stopping')).toContain('Stopping');
    expect(formatInstanceStatus('pending')).toContain('Starting');
    expect(formatInstanceStatus('terminated')).toContain('Terminated');
    expect(formatInstanceStatus('unknown')).toContain('unknown');
  });

  it('formats ssm status', () => {
    expect(formatSSMStatus('ready')).toContain('Ready');
    expect(formatSSMStatus('not-ready')).toContain('Not Ready');
    expect(formatSSMStatus('offline')).toContain('offline');
  });

  it('formats gateway status', () => {
    expect(formatGatewayStatus(true)).toContain('Running');
    expect(formatGatewayStatus(false)).toContain('Not Running');
    expect(formatGatewayStatus(false, 'boom')).toContain('boom');
  });
});
