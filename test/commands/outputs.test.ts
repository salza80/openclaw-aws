import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const spinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  warn: vi.fn().mockReturnThis(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => spinner),
}));

const buildCommandContextMock = vi.hoisted(() => vi.fn(async () => ({
  name: 'alpha',
  config: {
    aws: { region: 'us-east-1' },
    stack: { name: 'OpenclawStack-alpha' },
  },
  awsEnv: {},
})));

vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: buildCommandContextMock,
}));

const getStackOutputsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackOutputs: getStackOutputsMock,
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
import outputsCommand from '../../src/cli/commands/outputs.js';

type OutputsHandler = NonNullable<(typeof outputsCommand)['handler']>;
type OutputsHandlerArgs = Parameters<OutputsHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('outputs command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('formats SSM command outputs and prints quick commands', async () => {
    getStackOutputsMock.mockResolvedValue({
      SSMConnectCommand: 'aws ssm start-session --target i-123 --region us-east-1',
      GatewayUrl: 'https://example.com',
    });

    const handler = (outputsCommand as CommandModule).handler!;
    const args: OutputsHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('SSMConnectCommand');
    expect(output).toContain('aws ssm start-session');
    expect(output).toContain('--target i-123');
    expect(output).toContain('--region us-east-1');
    expect(output).toContain('Quick Commands');
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('prints no outputs when stack outputs are empty', async () => {
    getStackOutputsMock.mockResolvedValue({});

    const handler = (outputsCommand as CommandModule).handler!;
    const args: OutputsHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('No outputs found');
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('handles stack not found errors without throwing', async () => {
    getStackOutputsMock.mockRejectedValue(new Error('stack not found'));

    const handler = (outputsCommand as CommandModule).handler!;
    const args: OutputsHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(handleErrorMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('No deployment found');
  });
});
