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

const buildCommandContextMock = vi.hoisted(() =>
  vi.fn(async () => ({
    name: 'alpha',
    config: {
      aws: { region: 'us-east-1' },
      stack: { name: 'OpenclawStack-alpha' },
      instance: { name: 'openclaw-alpha' },
      openclaw: { apiProvider: 'anthropic-api-key' },
    },
    awsEnv: { AWS_PROFILE: 'test' },
  })),
);

vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: buildCommandContextMock,
}));

const getStackStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: getStackStatusMock,
}));

vi.mock('../../src/cli/utils/cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
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

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const destroyMock = vi.hoisted(() => vi.fn());
const createSsmClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    send: sendMock,
    destroy: destroyMock,
  })),
);

vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: createSsmClientMock,
}));

vi.mock('@aws-sdk/client-ssm', () => {
  class DeleteParameterCommand {
    input: { Name: string };
    constructor(input: { Name: string }) {
      this.input = input;
    }
  }
  return { DeleteParameterCommand };
});

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
import destroyCommand from '../../src/cli/commands/destroy.js';

type DestroyHandler = NonNullable<(typeof destroyCommand)['handler']>;
type DestroyHandlerArgs = Parameters<DestroyHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('destroy command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips destruction when stack is missing', async () => {
    getStackStatusMock.mockRejectedValue(new Error('stack not found'));
    promptsMock.mockResolvedValue({ deleteConfig: false });

    const handler = (destroyCommand as CommandModule).handler!;
    const args: DestroyHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('destroys stack when force is true', async () => {
    getStackStatusMock.mockResolvedValue({ instanceId: 'i-123', stackStatus: 'CREATE_COMPLETE' });
    execaMock.mockResolvedValue({});
    promptsMock.mockResolvedValue({ deleteConfig: false });

    const handler = (destroyCommand as CommandModule).handler!;
    const args: DestroyHandlerArgs = { force: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      'cdk',
      [
        'destroy',
        'OpenclawStack-alpha',
        '--app',
        expect.stringContaining('cdk/app.js'),
        '--no-notices',
        '--no-version-reporting',
        '--force',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_CONFIG_NAME: 'alpha',
          CDK_DISABLE_VERSION_CHECK: 'true',
          CDK_DISABLE_CLI_TELEMETRY: '1',
          CI: 'true',
        }),
      }),
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
