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

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({
  default: promptsMock,
}));

const buildCommandContextMock = vi.hoisted(() => vi.fn());
buildCommandContextMock.mockImplementation(async () => makeCommandContext());

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

vi.mock('@aws-sdk/client-ssm', async () => {
  const { createAwsCommandClass } = await import('../helpers/mocks/aws-commands.js');
  return {
    PutParameterCommand: createAwsCommandClass<{ Name: string; Value: string }>(),
  };
});

vi.mock('../../src/cli/utils/logger.js', async () => {
  const { createLoggerMock } = await import('../helpers/mocks/logger.js');
  return {
    logger: createLoggerMock(),
  };
});

vi.mock('../../src/cli/utils/errors.js', async () => {
  const { createErrorsModuleMock, passthroughWithRetry } =
    await import('../helpers/mocks/errors.js');
  return createErrorsModuleMock({
    handleError: vi.fn(),
    withRetry: passthroughWithRetry,
  });
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

  it('deploys when stack missing and autoApprove is true', async () => {
    getStackStatusMock.mockRejectedValue(new Error('not found'));
    resolveApiKeyMock.mockReturnValue('secret');
    execaMock.mockResolvedValue({});

    const handler = (deployCommand as CommandModule).handler!;
    const args: DeployHandlerArgs = { autoApprove: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).toHaveBeenCalledWith(
      'cdk',
      expect.arrayContaining(['deploy', 'OpenclawStack-alpha']),
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_CONFIG_NAME: 'alpha' }),
      }),
    );
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('deploys all configs when confirmed', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    getStackStatusMock.mockRejectedValue(new Error('not found'));
    resolveApiKeyMock.mockReturnValue('secret');
    promptsMock.mockResolvedValue({ confirmText: 'DEPLOY ALL' });
    execaMock.mockResolvedValue({});

    const handler = (deployCommand as CommandModule).handler!;
    const args: DeployHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(promptsMock).toHaveBeenCalled();
    expect(execaMock).toHaveBeenCalled();
  });
});
