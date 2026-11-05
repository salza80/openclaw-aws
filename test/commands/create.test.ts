import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  current: vi.fn(),
  defaults: vi.fn(),
  configure: vi.fn(),
  target: vi.fn(),
  stack: vi.fn(),
  ssm: vi.fn(),
  deploy: vi.fn(),
  validate: vi.fn(),
  key: vi.fn(),
  saved: vi.fn(),
}));
vi.mock('../../src/cli/commands/init.js', () => ({ configureDeployment: mocks.configure }));
vi.mock('../../src/cli/utils/config.js', () => ({
  configExistsByName: mocks.exists,
  loadConfigByName: mocks.defaults,
  getConfigPathByName: (name: string) => `/tmp/${name}.json`,
}));
vi.mock('../../src/cli/utils/config-store.js', () => ({ getCurrentName: mocks.current }));
vi.mock('../../src/cli/utils/aws.js', () => ({ getStackStatus: mocks.stack }));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: () => ({ send: mocks.ssm, destroy() {} }),
}));
vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  validatePreDeploy: mocks.validate,
  validateNodeVersion() {},
}));
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: mocks.target }));
vi.mock('../../src/operations/deployment.js', () => ({ deployDeployment: mocks.deploy }));
vi.mock('../../src/cli/utils/api-keys.js', async (original) => ({
  ...(await original<object>()),
  resolveApiKey: mocks.key,
}));
vi.mock('../../src/cli/utils/logger.js', () => ({
  logger: { info() {}, warn() {}, success() {} },
}));
import { createDeployment, providerChoice } from '../../src/cli/commands/create.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
beforeEach(() => {
  mocks.exists.mockReturnValue(false);
  mocks.current.mockReturnValue(null);
  mocks.target.mockResolvedValue(testTarget);
  mocks.key.mockReturnValue('private-key');
  mocks.stack.mockRejectedValue(new StackNotFoundError('OpenclawStack-alpha', 'us-east-1'));
  mocks.ssm.mockImplementation(async (command) => ({ InvalidParameters: command.input.Names }));
  mocks.configure.mockImplementation(async (args, options) => {
    const config = makeCommandContext().config;
    config.aws = { region: args.region ?? 'us-east-1', profile: args.profile };
    config.openclaw = { apiProvider: args.apiProvider, model: args.model };
    await options.beforeSave(config, args.name);
    mocks.saved(config);
    return { config, name: args.name };
  });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe('create workflow', () => {
  it('composes setup and the shared deployment operation using the selected identity', async () => {
    await createDeployment({
      name: 'alpha',
      provider: 'openrouter',
      region: 'eu-central-1',
      profile: 'work',
      yes: true,
      model: 'openrouter/openai/gpt-4.1-nano',
    });
    expect(mocks.target).toHaveBeenCalledWith({ region: 'eu-central-1', profile: 'work' });
    expect(mocks.saved).toHaveBeenCalledOnce();
    expect(mocks.validate).toHaveBeenCalledWith(expect.anything(), testTarget, true);
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alpha', target: testTarget }),
      expect.objectContaining({ apiProvider: 'openrouter-api-key', apiKey: 'private-key' }),
    );
  });
  it('inherits saved AWS/provider/model defaults and gives explicit options precedence', async () => {
    mocks.current.mockReturnValue('previous');
    const config = makeCommandContext().config;
    config.aws = { region: 'eu-central-1', profile: 'saved' };
    config.openclaw = {
      apiProvider: 'openrouter-api-key',
      model: 'openrouter/openai/gpt-4.1-nano',
    };
    mocks.defaults.mockReturnValue(config);
    await createDeployment({ name: 'alpha', yes: true });
    expect(mocks.configure.mock.calls[0][0]).toMatchObject({
      region: 'eu-central-1',
      profile: 'saved',
      apiProvider: 'openrouter-api-key',
      model: config.openclaw.model,
    });
    await createDeployment({ name: 'beta', yes: true, provider: 'anthropic', region: 'us-west-2' });
    expect(mocks.configure.mock.calls[1][0]).toMatchObject({
      region: 'us-west-2',
      apiProvider: 'anthropic-api-key',
      model: undefined,
    });
  });
  it('rejects local collisions before credentials, configuration or provisioning', async () => {
    mocks.exists.mockReturnValue(true);
    await expect(createDeployment({ name: 'alpha', yes: true })).rejects.toThrow('already exists');
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.target).not.toHaveBeenCalled();
  });
  it.each(['stack', 'secret', 'denied', 'unconfirmed'])(
    'rejects %s collisions/read failures before saving or provisioning',
    async (kind) => {
      if (kind === 'stack') mocks.stack.mockResolvedValue({ stackStatus: 'CREATE_COMPLETE' });
      if (kind === 'secret')
        mocks.ssm.mockResolvedValue({ Parameters: [{ Name: '/openclaw/alpha/api-key' }] });
      if (kind === 'denied')
        mocks.stack.mockRejectedValue(
          Object.assign(new Error('Access denied'), { name: 'AccessDenied' }),
        );
      if (kind === 'unconfirmed') mocks.ssm.mockResolvedValue({});
      await expect(createDeployment({ name: 'alpha', yes: true })).rejects.toThrow();
      expect(mocks.saved).not.toHaveBeenCalled();
      expect(mocks.deploy).not.toHaveBeenCalled();
    },
  );
  it('fails early and actionably for missing noninteractive secrets', async () => {
    mocks.key.mockReturnValue(undefined);
    await expect(
      createDeployment({ name: 'alpha', provider: 'openrouter', yes: true }),
    ).rejects.toThrow('OPENROUTER_API_KEY');
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.target).not.toHaveBeenCalled();
  });
  it('does not provision after setup cancellation', async () => {
    mocks.configure.mockResolvedValue(undefined);
    await createDeployment({ name: 'alpha', yes: true });
    expect(mocks.deploy).not.toHaveBeenCalled();
  });
  it('rejects path-like names and unsupported providers', async () => {
    await expect(createDeployment({ name: '../escape', yes: true })).rejects.toThrow();
    expect(() => providerChoice('unknown')).toThrow('Unsupported provider');
    expect(providerChoice('openrouter-api-key')).toBe('openrouter-api-key');
    expect(mocks.configure).not.toHaveBeenCalled();
  });
});
