import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAwsProfile } from '../../src/cli/utils/aws-profile.js';
import { buildAwsEnv } from '../../src/cli/utils/context.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';

describe('AWS profile selection across configs', () => {
  beforeEach(() => {
    applyAwsProfile();
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_SDK_LOAD_CONFIG', undefined);
  });

  afterEach(() => {
    applyAwsProfile();
    vi.unstubAllEnvs();
  });

  it('clears a config profile when the next config uses the default credential chain', () => {
    applyAwsProfile('account-a');
    applyAwsProfile();

    expect(process.env.AWS_PROFILE).toBeUndefined();
    expect(process.env.AWS_SDK_LOAD_CONFIG).toBeUndefined();
    expect(buildAwsEnv(makeCommandContext().config).AWS_PROFILE).toBeUndefined();
  });

  it('restores the shell profile after switching through multiple named configs', () => {
    vi.stubEnv('AWS_PROFILE', 'shell-profile');
    vi.stubEnv('AWS_SDK_LOAD_CONFIG', '0');

    applyAwsProfile('account-a');
    applyAwsProfile('account-b');
    expect(process.env.AWS_PROFILE).toBe('account-b');
    applyAwsProfile();

    expect(process.env.AWS_PROFILE).toBe('shell-profile');
    expect(process.env.AWS_SDK_LOAD_CONFIG).toBe('0');
  });

  it('builds independent subprocess environments without inheriting an active config profile', () => {
    vi.stubEnv('AWS_PROFILE', 'shell-profile');
    const config = makeCommandContext().config;

    applyAwsProfile('account-a');
    const defaultEnv = buildAwsEnv(config);
    const namedEnv = buildAwsEnv({ ...config, aws: { ...config.aws, profile: 'account-b' } });

    expect(defaultEnv.AWS_PROFILE).toBe('shell-profile');
    expect(defaultEnv.AWS_SDK_LOAD_CONFIG).toBeUndefined();
    expect(namedEnv.AWS_PROFILE).toBe('account-b');
    expect(namedEnv.AWS_SDK_LOAD_CONFIG).toBe('1');
    expect(process.env.AWS_PROFILE).toBe('account-a');
  });
});
