import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({
  default: promptsMock,
}));

const configExistsByNameMock = vi.hoisted(() => vi.fn());
const saveConfigByNameMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config.js', () => ({
  configExistsByName: configExistsByNameMock,
  saveConfigByName: saveConfigByNameMock,
}));

const setCurrentNameMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config-store.js', () => ({
  setCurrentName: setCurrentNameMock,
}));

vi.mock('../../src/cli/utils/logger.js', async () => {
  const { createLoggerMock } = await import('../helpers/mocks/logger.js');
  return {
    logger: createLoggerMock(),
  };
});

vi.mock('../../src/cli/commands/deploy.js', () => ({
  default: {
    handler: vi.fn(),
  },
}));

vi.mock('../../src/cli/utils/errors.js', async () => {
  const { createErrorsModuleMock } = await import('../helpers/mocks/errors.js');
  return createErrorsModuleMock({ handleError: vi.fn() });
});

import { handleError, ValidationError } from '../../src/cli/utils/errors.js';
import { logger } from '../../src/cli/utils/logger.js';
import deployCommand from '../../src/cli/commands/deploy.js';

type InitHandler = NonNullable<
  (typeof import('../../src/cli/commands/init.js'))['default']['handler']
>;
type InitHandlerArgs = Parameters<InitHandler>[0];
const handleErrorMock = vi.mocked(handleError);

describe('init command (mocked)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls handleError on invalid apiProvider', async () => {
    const { default: initCommand } = await import('../../src/cli/commands/init.js');
    const handler = (initCommand as CommandModule).handler!;
    const args = { apiProvider: 'invalid-provider', _: [], $0: 'openclaw-aws' } as InitHandlerArgs;
    await handler(args);

    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    const [error] = handleErrorMock.mock.calls[0];
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('returns early when config exists and overwrite is false', async () => {
    configExistsByNameMock.mockReturnValue(true);
    promptsMock.mockResolvedValue({ overwrite: false });

    const { default: initCommand } = await import('../../src/cli/commands/init.js');
    const handler = (initCommand as CommandModule).handler!;
    const args = { name: 'alpha', _: [], $0: 'openclaw-aws' } as InitHandlerArgs;
    await handler(args);

    expect(logger.info).toHaveBeenCalledWith('Configuration unchanged');
    expect(saveConfigByNameMock).not.toHaveBeenCalled();
    expect(setCurrentNameMock).not.toHaveBeenCalled();
  });

  it('warns and exits when user cancels interactive prompts', async () => {
    configExistsByNameMock.mockReturnValue(false);
    promptsMock.mockResolvedValue({ deploymentName: '' });

    const { default: initCommand } = await import('../../src/cli/commands/init.js');
    const handler = (initCommand as CommandModule).handler!;
    const args = { _: [], $0: 'openclaw-aws' } as InitHandlerArgs;
    await handler(args);

    expect(logger.warn).toHaveBeenCalledWith('Setup cancelled');
    expect(saveConfigByNameMock).not.toHaveBeenCalled();
  });

  it('warns when deployment already exists after prompts', async () => {
    configExistsByNameMock.mockReturnValue(true);
    promptsMock.mockResolvedValue({
      deploymentName: 'alpha',
      region: 'us-east-1',
      useDefaultVpc: true,
      instanceType: 't3.micro',
      instanceName: 'openclaw-alpha',
      apiProvider: 'anthropic-api-key',
      cloudWatchLogs: true,
    });

    const { default: initCommand } = await import('../../src/cli/commands/init.js');
    const handler = (initCommand as CommandModule).handler!;
    const args = { _: [], $0: 'openclaw-aws' } as InitHandlerArgs;
    await handler(args);

    expect(logger.warn).toHaveBeenCalledWith('Deployment "alpha" already exists');
    expect(saveConfigByNameMock).not.toHaveBeenCalled();
  });

  it('saves config and skips deploy when deployNow is false', async () => {
    configExistsByNameMock.mockReturnValue(false);
    promptsMock
      .mockResolvedValueOnce({
        deploymentName: 'alpha',
        region: 'us-east-1',
        useDefaultVpc: true,
        instanceType: 't3.micro',
        instanceName: 'openclaw-alpha',
        apiProvider: 'anthropic-api-key',
        cloudWatchLogs: true,
      })
      .mockResolvedValueOnce({ deployNow: false });

    const { default: initCommand } = await import('../../src/cli/commands/init.js');
    const handler = (initCommand as CommandModule).handler!;
    const args = { _: [], $0: 'openclaw-aws' } as InitHandlerArgs;
    await handler(args);

    expect(saveConfigByNameMock).toHaveBeenCalledTimes(1);
    expect(setCurrentNameMock).toHaveBeenCalledWith('alpha');
    expect(deployCommand.handler).not.toHaveBeenCalled();
  });

  it('calls deploy when deployNow is true', async () => {
    configExistsByNameMock.mockReturnValue(false);
    promptsMock
      .mockResolvedValueOnce({
        deploymentName: 'alpha',
        region: 'us-east-1',
        useDefaultVpc: true,
        instanceType: 't3.micro',
        instanceName: 'openclaw-alpha',
        apiProvider: 'anthropic-api-key',
        cloudWatchLogs: true,
      })
      .mockResolvedValueOnce({ deployNow: true });

    const { default: initCommand } = await import('../../src/cli/commands/init.js');
    const handler = (initCommand as CommandModule).handler!;
    const args = { _: [], $0: 'openclaw-aws' } as InitHandlerArgs;
    await handler(args);

    expect(deployCommand.handler).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alpha', autoApprove: false }),
    );
  });
});
