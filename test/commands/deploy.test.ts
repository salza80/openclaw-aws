import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';

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
const getInstanceIdMock = vi.hoisted(() => vi.fn(async () => 'i-test'));
const waitForSSMMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: getStackStatusMock,
  getInstanceIdFromStack: getInstanceIdMock,
  waitForSSM: waitForSSMMock,
}));

vi.mock('../../src/cli/utils/cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
  getCDKAppCommand: vi.fn((value: string) => `node ${value}`),
  withCDKWorkspace: async (env: object, operation: (value: object) => Promise<unknown>) =>
    operation({ env, cwd: process.cwd() }),
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

const ssmSendMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: vi.fn(() => ({
    send: ssmSendMock,
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
    withRetry: vi.fn(passthroughWithRetry),
  });
});

import {
  AWSError,
  StackNotFoundError,
  handleError,
  withRetry,
} from '../../src/cli/utils/errors.js';
import { validatePreDeploy } from '../../src/cli/utils/aws-validation.js';
import deployCommand from '../../src/cli/commands/deploy.js';

type DeployHandler = NonNullable<(typeof deployCommand)['handler']>;
type DeployHandlerArgs = Parameters<DeployHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('deploy command', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
    execaMock.mockReset();
    waitForSSMMock.mockResolvedValue(true);
    buildCommandContextMock.mockImplementation(async () => makeCommandContext());
  });

  it('redacts resolved role credentials from deployment failures without relying on global environment values', async () => {
    const role = {
      AWS_ACCESS_KEY_ID: 'resolved-access-key',
      AWS_SECRET_ACCESS_KEY: 'resolved-secret-key',
      AWS_SESSION_TOKEN: 'resolved-session-token',
    };
    buildCommandContextMock.mockResolvedValue(
      makeCommandContext({ target: { ...testTarget, environment: async () => role } }),
    );
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );
    resolveApiKeyMock.mockReturnValue('private-provider-key');
    execaMock.mockImplementation(async (_binary, args) => {
      if (args[0] === '--version') return {};
      throw new Error(Object.values(role).join(' '));
    });
    await deployCommand.handler?.({ autoApprove: true, _: [], $0: 'openclaw-aws' });
    const failure = handleErrorMock.mock.calls[0][0] as Error;
    for (const value of Object.values(role)) expect(failure.message).not.toContain(value);
    expect(failure.message).toContain('[REDACTED]');
  });

  it('keeps the planned batch context through approval instead of selecting edited targets again', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );
    resolveApiKeyMock.mockReturnValue('private-key');
    promptsMock.mockImplementation(async () => {
      buildCommandContextMock.mockRejectedValue(new Error('Configuration changed after approval'));
      return { confirmText: 'DEPLOY ALL' };
    });
    await deployCommand.handler?.({ all: true, _: [], $0: 'openclaw-aws' });
    expect(buildCommandContextMock).toHaveBeenCalledTimes(1);
    expect(execaMock.mock.calls.some(([, args]) => args[0] === 'deploy')).toBe(true);
    expect(handleErrorMock).not.toHaveBeenCalled();
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
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );
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
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );
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
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );
    resolveApiKeyMock.mockReturnValue('secret');
    promptsMock.mockResolvedValue({ confirmText: 'DEPLOY ALL' });
    execaMock.mockResolvedValue({});

    const handler = (deployCommand as CommandModule).handler!;
    const args: DeployHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(promptsMock).toHaveBeenCalled();
    expect(execaMock).toHaveBeenCalled();
  });
  it.each([false, true])(
    'reports an existing stack when final SSM readiness fails (all=%s)',
    async (all) => {
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockRejectedValue(
        new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
      );
      resolveApiKeyMock.mockReturnValue('secret');
      execaMock.mockResolvedValue({});
      promptsMock.mockResolvedValue({ confirmText: 'DEPLOY ALL' });
      waitForSSMMock.mockResolvedValue(false);
      const args: DeployHandlerArgs = { all, autoApprove: true, _: [], $0: 'openclaw-aws' };
      await (deployCommand as CommandModule).handler!(args);
      expect(handleErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('was created but SSM connectivity was not confirmed'),
        }),
      );
      expect(waitForSSMMock).toHaveBeenCalledWith('i-test', testTarget);
    },
  );

  it.each(['CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'UPDATE_COMPLETE'])(
    'does not mutate an existing %s stack',
    async (stackStatus) => {
      getStackStatusMock.mockResolvedValue({ stackStatus });
      await (deployCommand as CommandModule).handler!({ _: [], $0: 'openclaw-aws' });
      expect(execaMock).not.toHaveBeenCalled();
      expect(waitForSSMMock).not.toHaveBeenCalled();
      expect(handleErrorMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { all: false, stackStatus: 'CREATE_FAILED' },
    { all: true, stackStatus: 'CREATE_FAILED' },
    { all: false, stackStatus: 'ROLLBACK_COMPLETE' },
    { all: true, stackStatus: 'ROLLBACK_FAILED' },
    { all: false, stackStatus: 'DELETE_FAILED' },
    { all: true, stackStatus: 'UPDATE_ROLLBACK_FAILED' },
  ])(
    'reports an existing failed stack without changing it: $stackStatus (all=$all)',
    async ({ all, stackStatus }) => {
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockResolvedValue({ stackStatus });

      await deployCommand.handler?.({ all, autoApprove: true, _: [], $0: 'openclaw-aws' });

      expect(handleErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(`already exists in ${stackStatus}`),
          suggestions: expect.arrayContaining([
            expect.stringContaining('openclaw-aws destroy --name alpha'),
          ]),
        }),
      );
      expect(resolveApiKeyMock).not.toHaveBeenCalled();
      expect(ssmSendMock).not.toHaveBeenCalled();
      expect(execaMock).not.toHaveBeenCalled();
      expect(waitForSSMMock).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join('\n')).not.toContain('All configs are already deployed');
    },
  );

  it.each([false, true])(
    'preserves failed creations and reports diagnostic/cleanup guidance (all=%s)',
    async (all) => {
      const key = 'sensitive-"provider"-key';
      const escapedKey = JSON.stringify(key).slice(1, -1);
      const encodedKey = encodeURIComponent(key);
      const originalError = new Error(
        `CREATE_FAILED: onboarding refused ${key}; escaped=${escapedKey}; encoded=${encodedKey}`,
      );
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockRejectedValue(
        new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
      );
      resolveApiKeyMock.mockReturnValue(key);
      promptsMock.mockResolvedValue({ confirmText: 'DEPLOY ALL' });
      execaMock.mockImplementation(async (_binary, args) => {
        if (args[0] === '--version') return {};
        throw originalError;
      });

      await deployCommand.handler?.({ all, autoApprove: true, _: [], $0: 'openclaw-aws' });

      expect(execaMock).toHaveBeenCalledWith(
        'cdk',
        expect.arrayContaining(['deploy', 'OpenclawStack-alpha', '--no-rollback']),
        expect.any(Object),
      );
      const failure = handleErrorMock.mock.calls[0][0] as AWSError;
      expect(failure.cause).toBe(originalError);
      expect(failure.message).toContain('CREATE_FAILED: onboarding refused [REDACTED]');
      expect(failure.message).toContain('continue to incur AWS charges');
      expect(failure.message).not.toContain(key);
      expect(failure.message).not.toContain(escapedKey);
      expect(failure.message).not.toContain(encodedKey);
      expect(failure.suggestions).toEqual(
        expect.arrayContaining([
          expect.stringContaining('openclaw-aws connect --name alpha'),
          expect.stringContaining('openclaw-aws destroy --name alpha'),
        ]),
      );
      expect(waitForSSMMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not retry CDK after a transient error leaves a stack to inspect (all=%s)',
    async (all) => {
      const originalError = new Error('network timeout waiting for the deployment');
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock
        .mockRejectedValueOnce(new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'))
        .mockRejectedValueOnce(new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'))
        .mockResolvedValue({ stackStatus: 'CREATE_FAILED' });
      resolveApiKeyMock.mockReturnValue('secret');
      promptsMock.mockResolvedValue({ confirmText: 'DEPLOY ALL' });
      execaMock.mockImplementation(async (_binary, args) => {
        if (args[0] === '--version') return {};
        throw originalError;
      });
      vi.mocked(withRetry).mockImplementationOnce(async (operation, options) => {
        try {
          return await operation();
        } catch (error) {
          if (options?.shouldRetry?.(error)) return operation();
          throw error;
        }
      });

      await deployCommand.handler?.({ all, autoApprove: true, _: [], $0: 'openclaw-aws' });

      expect(execaMock.mock.calls.filter(([, args]) => args[0] === 'deploy')).toHaveLength(1);
      expect(getStackStatusMock).toHaveBeenCalledTimes(3);
      expect(ssmSendMock).toHaveBeenCalledTimes(2);
      expect(handleErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({ cause: originalError }),
      );
    },
  );

  it.each([false, true])(
    'skips an existing legacy Cloudflare stack without new routing IDs (all=%s)',
    async (all) => {
      const context = makeCommandContext();
      context.config.openclaw = { apiProvider: 'cloudflare-ai-gateway-api-key' };
      buildCommandContextMock.mockResolvedValue(context);
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockResolvedValue({ stackStatus: 'CREATE_COMPLETE' });

      await deployCommand.handler?.({ all, autoApprove: true, _: [], $0: 'openclaw-aws' });

      expect(getStackStatusMock).toHaveBeenCalledWith(context.config.stack.name, context.target);
      expect(resolveApiKeyMock).not.toHaveBeenCalled();
      expect(validatePreDeploy).not.toHaveBeenCalled();
      expect(ssmSendMock).not.toHaveBeenCalled();
      expect(execaMock).not.toHaveBeenCalled();
      expect(waitForSSMMock).not.toHaveBeenCalled();
      expect(handleErrorMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rejects a new Cloudflare deployment without routing IDs before any writes (all=%s)',
    async (all) => {
      const context = makeCommandContext();
      context.config.openclaw = { apiProvider: 'cloudflare-ai-gateway-api-key' };
      buildCommandContextMock.mockResolvedValue(context);
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockRejectedValue(
        new StackNotFoundError(context.config.stack.name, context.target),
      );
      resolveApiKeyMock.mockReturnValue('secret');

      await deployCommand.handler?.({ all, autoApprove: true, _: [], $0: 'openclaw-aws' });

      expect(handleErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('openclaw.cloudflare.accountId'),
        }),
      );
      expect(resolveApiKeyMock).not.toHaveBeenCalled();
      expect(validatePreDeploy).not.toHaveBeenCalled();
      expect(ssmSendMock).not.toHaveBeenCalled();
      expect(execaMock).not.toHaveBeenCalled();
      expect(waitForSSMMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'provisions Cloudflare once both routing IDs are present (all=%s)',
    async (all) => {
      const context = makeCommandContext();
      context.config.openclaw = {
        apiProvider: 'cloudflare-ai-gateway-api-key',
        cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'my-gateway' },
      };
      context.awsEnv.OPENCLAW_CDK_OPERATION = 'destroy';
      buildCommandContextMock.mockResolvedValue(context);
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockRejectedValue(
        new StackNotFoundError(context.config.stack.name, context.target),
      );
      resolveApiKeyMock.mockReturnValue('secret');
      promptsMock.mockResolvedValue({ confirmText: 'DEPLOY ALL' });
      execaMock.mockResolvedValue({});

      await deployCommand.handler?.({ all, autoApprove: true, _: [], $0: 'openclaw-aws' });

      expect(ssmSendMock).toHaveBeenCalledTimes(2);
      expect(execaMock).toHaveBeenCalledWith(
        'cdk',
        expect.arrayContaining(['deploy', context.config.stack.name]),
        expect.objectContaining({
          env: expect.objectContaining({ OPENCLAW_CDK_OPERATION: 'deploy' }),
        }),
      );
      expect(waitForSSMMock).toHaveBeenCalledWith('i-test', context.target);
      expect(handleErrorMock).not.toHaveBeenCalled();
    },
  );
});
