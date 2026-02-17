import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
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

const getStackStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: getStackStatusMock,
}));

vi.mock('../../src/cli/utils/cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
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
    getStackStatusMock.mockRejectedValue(new Error('not found'));

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
