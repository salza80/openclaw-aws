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
  stop: vi.fn().mockReturnThis(),
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
      instance: { name: 'openclaw-alpha', type: 't3.micro' },
      openclaw: { apiProvider: 'anthropic-api-key' },
    },
    awsEnv: { AWS_PROFILE: 'test' },
  })),
);

vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: buildCommandContextMock,
}));

const listConfigNamesMock = vi.hoisted(() => vi.fn());
const resolveOutputsPathMock = vi.hoisted(() => vi.fn(() => '/tmp/outputs.json'));
vi.mock('../../src/cli/utils/config-store.js', () => ({
  listConfigNames: listConfigNamesMock,
  resolveOutputsPath: resolveOutputsPathMock,
}));

const getStackStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: getStackStatusMock,
}));

vi.mock('../../src/cli/utils/cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
}));

vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  validatePreDeploy: vi.fn(async () => {}),
  validateNodeVersion: vi.fn(() => {}),
}));

const resolveApiKeyMock = vi.hoisted(() => vi.fn());
const getApiKeyEnvVarMock = vi.hoisted(() => vi.fn(() => 'TEST_KEY'));
vi.mock('../../src/cli/utils/api-keys.js', () => ({
  resolveApiKey: resolveApiKeyMock,
  getApiKeyEnvVar: getApiKeyEnvVarMock,
  getApiKeyParamName: vi.fn(() => 'param'),
  getGatewayTokenParamName: vi.fn(() => 'param-token'),
}));

vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: vi.fn(() => ({
    send: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('@aws-sdk/client-ssm', () => {
  class PutParameterCommand {
    input: { Name: string; Value: string };
    constructor(input: { Name: string; Value: string }) {
      this.input = input;
    }
  }
  return { PutParameterCommand };
});

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
import deployCommand from '../../src/cli/commands/deploy.js';

type DeployHandler = NonNullable<(typeof deployCommand)['handler']>;
type DeployHandlerArgs = Parameters<DeployHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('deploy command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when deploying all but no configs exist', async () => {
    listConfigNamesMock.mockReturnValue([]);

    const handler = (deployCommand as CommandModule).handler!;
    const args: DeployHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openclaw-aws init --name <name>');
  });

  it('returns when stack already exists', async () => {
    getStackStatusMock.mockResolvedValue({ stackStatus: 'CREATE_COMPLETE' });

    const handler = (deployCommand as CommandModule).handler!;
    const args: DeployHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(getStackStatusMock).toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('calls handleError when API key is missing', async () => {
    getStackStatusMock.mockRejectedValue(new Error('not found'));
    resolveApiKeyMock.mockReturnValue(undefined);

    const handler = (deployCommand as CommandModule).handler!;
    const args: DeployHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    const [error] = handleErrorMock.mock.calls[0];
    expect(error).toBeInstanceOf(AWSError);
    expect((error as AWSError).message).toContain('Missing API key');
  });
});
