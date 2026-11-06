import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import type { CommandModule } from 'yargs';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';

vi.mock('../../src/operations/state.js', () => ({ assertDeploymentTarget: vi.fn() }));

const recoveryCleanupMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/aws/recovery-source.js', () => ({
  removeSourceRecoveryAccess: recoveryCleanupMock,
}));

const withLockMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, operation: () => Promise<void>) => operation()),
);
vi.mock('../../src/operations/lock.js', () => ({ withDeploymentLock: withLockMock }));

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

const getStackStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: getStackStatusMock,
}));

vi.mock('../../src/cli/utils/cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
  getCDKAppCommand: vi.fn((value: string) => `node ${value}`),
  withCDKWorkspace: async (env: object, operation: (value: object) => Promise<unknown>) =>
    operation({ env, cwd: process.cwd() }),
}));

const listConfigNamesMock = vi.hoisted(() => vi.fn());
const getCurrentNameMock = vi.hoisted(() => vi.fn());
const clearCurrentNameMock = vi.hoisted(() => vi.fn());
const setCurrentNameMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config-store.js', () => ({
  listConfigNames: listConfigNamesMock,
  getCurrentName: getCurrentNameMock,
  clearCurrentName: clearCurrentNameMock,
  setCurrentName: setCurrentNameMock,
}));

const getConfigPathByNameMock = vi.hoisted(() => vi.fn((name: string) => `/tmp/${name}.json`));
vi.mock('../../src/cli/utils/config.js', () => ({
  getConfigPathByName: getConfigPathByNameMock,
}));

vi.mock('../../src/cli/utils/logger.js', async () => {
  const { createLoggerMock } = await import('../helpers/mocks/logger.js');
  return {
    logger: createLoggerMock(),
  };
});

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

vi.mock('@aws-sdk/client-ssm', async () => {
  const { createAwsCommandClass } = await import('../helpers/mocks/aws-commands.js');
  return {
    DeleteParameterCommand: createAwsCommandClass<{ Name: string }>(),
  };
});

vi.mock('../../src/cli/utils/errors.js', async () => {
  const { createErrorsModuleMock } = await import('../helpers/mocks/errors.js');
  return createErrorsModuleMock({ handleError: vi.fn() });
});

import { AWSError, handleError, StackNotFoundError } from '../../src/cli/utils/errors.js';
import destroyCommand from '../../src/cli/commands/destroy.js';

type DestroyHandler = NonNullable<(typeof destroyCommand)['handler']>;
type DestroyHandlerArgs = Parameters<DestroyHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('destroy command', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    buildCommandContextMock.mockImplementation(async () => makeCommandContext());
  });

  it('does not read, destroy or clean up while another operation owns the target lock', async () => {
    const busy = new AWSError('Deployment lock is held');
    withLockMock.mockRejectedValueOnce(busy);
    await destroyCommand.handler?.({ name: 'alpha', force: true, _: [], $0: 'openclaw-aws' });
    expect(getStackStatusMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(handleErrorMock).toHaveBeenCalledWith(busy);
  });

  it('skips destruction when stack is missing', async () => {
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );
    promptsMock.mockResolvedValue({ deleteConfig: false });

    const handler = (destroyCommand as CommandModule).handler!;
    const args: DestroyHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { all: false, message: 'Access denied' },
    { all: false, message: 'Network timeout' },
    { all: false, message: 'AWS credentials not found' },
    { all: true, message: 'Access denied' },
    { all: true, message: 'Network timeout' },
    { all: true, message: 'AWS credentials not found' },
  ])(
    'preserves secrets and configs on lookup error: $message (all=$all)',
    async ({ all, message }) => {
      const error = new Error(message);
      getStackStatusMock.mockRejectedValue(error);
      listConfigNamesMock.mockReturnValue(['alpha']);
      promptsMock.mockResolvedValue({ confirmText: 'DESTROY ALL' });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      const handler = (destroyCommand as CommandModule).handler!;
      const args: DestroyHandlerArgs = { all, deleteConfig: true, _: [], $0: 'openclaw-aws' };
      await handler(args);

      expect(handleErrorMock).toHaveBeenCalledWith(error);
      expect(execaMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(clearCurrentNameMock).not.toHaveBeenCalled();
      expect(setCurrentNameMock).not.toHaveBeenCalled();
    },
  );

  it('does not destroy or delete source secrets when recovery access cleanup fails', async () => {
    getStackStatusMock.mockResolvedValue({
      instanceId: 'i-123',
      stackStatus: 'CREATE_COMPLETE',
      stackId: 'source-stack-id',
    });
    recoveryCleanupMock.mockRejectedValueOnce(new AWSError('Denied recovery policy inspection'));
    await destroyCommand.handler?.({ force: true, deleteConfig: true, _: [], $0: 'openclaw-aws' });
    expect(execaMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(handleErrorMock).toHaveBeenCalled();
  });

  it('destroys stack when force is true', async () => {
    getStackStatusMock.mockResolvedValue({
      instanceId: 'i-123',
      stackStatus: 'CREATE_COMPLETE',
      stackId: 'source-stack-id',
    });
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
          OPENCLAW_CDK_OPERATION: 'destroy',
          CDK_DISABLE_VERSION_CHECK: 'true',
          CDK_DISABLE_CLI_TELEMETRY: '1',
          CI: 'true',
        }),
      }),
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'uses the destroy assembly for a legacy Cloudflare config (all=%s)',
    async (all) => {
      const context = makeCommandContext();
      context.config.openclaw = { apiProvider: 'cloudflare-ai-gateway-api-key' };
      context.awsEnv.OPENCLAW_CDK_OPERATION = 'deploy';
      buildCommandContextMock.mockResolvedValue(context);
      listConfigNamesMock.mockReturnValue(['alpha']);
      getStackStatusMock.mockResolvedValue({
        instanceId: 'i-123',
        stackStatus: 'CREATE_COMPLETE',
        stackId: 'source-stack-id',
      });
      execaMock.mockResolvedValue({});
      promptsMock.mockResolvedValue({ confirmText: 'DESTROY ALL', deleteConfig: false });

      await destroyCommand.handler?.({ all, force: true, _: [], $0: 'openclaw-aws' });

      expect(execaMock).toHaveBeenCalledWith(
        'cdk',
        expect.arrayContaining(['destroy', context.config.stack.name]),
        expect.objectContaining({
          env: expect.objectContaining({ OPENCLAW_CDK_OPERATION: 'destroy' }),
        }),
      );
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(handleErrorMock).not.toHaveBeenCalled();
    },
  );

  it('all mode returns early when no configs exist', async () => {
    listConfigNamesMock.mockReturnValue([]);

    const handler = (destroyCommand as CommandModule).handler!;
    const args: DestroyHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).not.toHaveBeenCalled();
    expect(handleErrorMock).not.toHaveBeenCalled();
  });

  it('all mode cancels when confirm text is wrong', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    promptsMock.mockResolvedValue({ confirmText: 'NOPE' });

    const handler = (destroyCommand as CommandModule).handler!;
    const args: DestroyHandlerArgs = { all: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(execaMock).not.toHaveBeenCalled();
  });

  it('deletes config files in all mode when deleteConfig is true', async () => {
    listConfigNamesMock.mockReturnValue(['alpha']);
    promptsMock.mockResolvedValue({ confirmText: 'DESTROY ALL' });
    getStackStatusMock.mockRejectedValue(
      new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'),
    );

    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    const handler = (destroyCommand as CommandModule).handler!;
    const args: DestroyHandlerArgs = { all: true, deleteConfig: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/alpha.json');
    existsSpy.mockRestore();
    unlinkSpy.mockRestore();
  });
});
