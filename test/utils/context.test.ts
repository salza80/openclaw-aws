import { describe, it, expect, vi, afterEach } from 'vitest';

const resolveConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/config-store.js', () => ({
  resolveConfig: resolveConfigMock,
}));

const requireAwsCredentialsMock = vi.hoisted(() => vi.fn());
const applyAwsProfileMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  requireAwsCredentials: requireAwsCredentialsMock,
  applyAwsProfile: applyAwsProfileMock,
}));

import { buildCommandContext, buildAwsEnv } from '../../src/cli/utils/context.js';

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

    const ctx = await buildCommandContext();

    expect(requireAwsCredentialsMock).toHaveBeenCalled();
    expect(applyAwsProfileMock).not.toHaveBeenCalled();
    expect(ctx.name).toBe('alpha');
    expect(ctx.awsEnv.AWS_REGION).toBe('us-east-1');
    expect(ctx.awsEnv.AWS_PROFILE).toBe('dev');
  });

  it('buildCommandContext skips credential check when requireCredentials is false', async () => {
    resolveConfigMock.mockReturnValue({
      name: 'alpha',
      config: { aws: { region: 'us-east-1', profile: 'dev' } },
      configPath: '/tmp/alpha.json',
    });

    await buildCommandContext({ requireCredentials: false });

    expect(requireAwsCredentialsMock).not.toHaveBeenCalled();
    expect(applyAwsProfileMock).toHaveBeenCalledWith('dev');
  });

  it('buildAwsEnv sets region and optional profile', () => {
    const env = buildAwsEnv({ aws: { region: 'us-east-1', profile: 'dev' } } as never);
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.AWS_PROFILE).toBe('dev');
  });
});
