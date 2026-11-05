import { describe, it, expect, vi, afterEach } from 'vitest';

const resolveConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config-store.js', () => ({
  resolveConfig: resolveConfigMock,
}));

const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: resolveTarget }));
import { buildCommandContext } from '../../src/cli/utils/context.js';
import { testTarget } from '../helpers/fixtures/command-context.js';

describe('context utils', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('buildCommandContext requires credentials by default', async () => {
    resolveConfigMock.mockReturnValue({
      name: 'alpha',
      config: { aws: { region: 'us-east-1', profile: 'dev' } },
      configPath: '/tmp/alpha.json',
    });

    resolveTarget.mockResolvedValue(testTarget);
    const ctx = await buildCommandContext();

    expect(resolveTarget).toHaveBeenCalledWith({ region: 'us-east-1', profile: 'dev' });
    expect(ctx.target).toBe(testTarget);
    expect(ctx.name).toBe('alpha');
    expect(ctx.awsEnv.AWS_REGION).toBe('us-east-1');
    expect(ctx.awsEnv.AWS_PROFILE).toBeUndefined();
  });
});
