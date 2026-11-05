import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SSMClient } from '@aws-sdk/client-ssm';
const mocks = vi.hoisted(() => ({ provider: vi.fn(), identify: vi.fn(), export: vi.fn() }));
vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: mocks.provider }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(private config: { credentials: unknown }) {}
    send() {
      return mocks.identify(this.config.credentials);
    }
    destroy() {}
  },
  GetCallerIdentityCommand: class {},
}));
vi.mock('execa', () => ({ execa: mocks.export }));
import { resolveAwsTarget, awsClientConfig } from '../../src/aws/target.js';
const identity = { Account: '123456789012', Arn: 'arn:role/test/session', UserId: 'test' };
const credential = (key: string, remaining = 3_600_000) => ({
  accessKeyId: key,
  secretAccessKey: `secret-${key}`,
  sessionToken: `session-${key}`,
  expiration: new Date(Date.now() + remaining),
});
beforeEach(() => {
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AWS_DEFAULT_PROFILE', undefined);
  vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
  mocks.identify.mockResolvedValue(identity);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('explicit AWS targets', () => {
  it('isolates overlapping profiles without changing the caller and shares SDK/child identity', async () => {
    vi.stubEnv('AWS_PROFILE', 'caller');
    mocks.provider.mockImplementation(
      ({ profile }) =>
        async () =>
          credential(profile),
    );
    const [alpha, beta] = await Promise.all([
      resolveAwsTarget({ region: 'eu-central-1', profile: 'alpha' }),
      resolveAwsTarget({ region: 'us-east-1', profile: 'beta' }),
    ]);
    expect(process.env.AWS_PROFILE).toBe('caller');
    for (const target of [alpha, beta]) {
      const client = new SSMClient(awsClientConfig(target));
      const sdk = await client.config.credentials();
      const child = await target.environment();
      expect(child.AWS_ACCESS_KEY_ID).toBe(sdk.accessKeyId);
      expect(child.AWS_SESSION_TOKEN).toBe(sdk.sessionToken);
      expect(child.AWS_PROFILE).toBeUndefined();
      expect(child.AWS_REGION).toBe(target.region);
      client.destroy();
    }
    expect((await alpha.credentials()).accessKeyId).toBe('alpha');
    expect((await beta.credentials()).accessKeyId).toBe('beta');
  });
  it('captures caller options and returns independent credential values', async () => {
    mocks.provider.mockImplementation(
      ({ profile }) =>
        async () =>
          credential(profile),
    );
    const options = { region: 'eu-central-1', profile: 'original' };
    const target = await resolveAwsTarget(options);
    options.region = 'us-east-1';
    options.profile = 'other';
    const credentials = await target.credentials();
    credentials.accessKeyId = 'changed';
    credentials.expiration?.setTime(0);
    expect((await target.environment()).AWS_REGION).toBe('eu-central-1');
    expect((await target.credentials()).accessKeyId).toBe('original');
    expect(target.region).toBe('eu-central-1');
  });

  it('captures ambient environment credentials once while explicit profiles take precedence', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'environment');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'private');
    const target = await resolveAwsTarget({ region: 'eu-central-1' });
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'changed');
    expect((await target.credentials()).accessKeyId).toBe('environment');
    mocks.provider.mockReturnValue(async () => credential('profile'));
    expect(
      (await (await resolveAwsTarget({ region: 'us-east-1', profile: 'explicit' })).credentials())
        .accessKeyId,
    ).toBe('profile');
  });
  it('refreshes through the original provider and checks identity before exposing credentials', async () => {
    const provider = vi
      .fn()
      .mockResolvedValueOnce(credential('old', 90_000))
      .mockResolvedValue(credential('new'));
    mocks.provider.mockReturnValue(provider);
    const target = await resolveAwsTarget({ region: 'eu-central-1', profile: 'alpha' });
    const env = await target.environment(25 * 60_000);
    expect(env.AWS_ACCESS_KEY_ID).toBe('new');
    expect(provider).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(mocks.identify).toHaveBeenCalledTimes(2);
  });
  it('fails closed when a refreshed source changes identity', async () => {
    mocks.provider.mockReturnValue(
      vi.fn().mockResolvedValueOnce(credential('old', 90_000)).mockResolvedValue(credential('new')),
    );
    const target = await resolveAwsTarget({ region: 'eu-central-1' });
    mocks.identify.mockResolvedValue({ ...identity, Account: '999999999999' });
    await expect(target.environment(25 * 60_000)).rejects.toThrow('identity changed');
  });
  it('rejects credentials too short for a bounded deployment', async () => {
    mocks.provider.mockReturnValue(async () => credential('short', 90_000));
    const target = await resolveAwsTarget({ region: 'eu-central-1' });
    await expect(target.environment(25 * 60_000)).rejects.toThrow('expire too soon');
  });
  it('privately uses an unexpired CLI role credential for expired SSO and pins it for SDK and children', async () => {
    mocks.provider.mockReturnValue(async () => {
      throw new Error('SSO token expired');
    });
    mocks.export.mockResolvedValue({
      stdout: JSON.stringify({
        Version: 1,
        AccessKeyId: 'exported',
        SecretAccessKey: 'private',
        SessionToken: 'private-token',
        Expiration: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    const target = await resolveAwsTarget({ region: 'eu-central-1', profile: 'default' });
    expect((await target.credentials()).accessKeyId).toBe('exported');
    expect((await target.environment()).AWS_ACCESS_KEY_ID).toBe('exported');
    expect(mocks.export).toHaveBeenCalledWith(
      'aws',
      ['configure', 'export-credentials', '--profile', 'default', '--format', 'process'],
      expect.objectContaining({ extendEnv: false }),
    );
  });
  it('does not fall back on unrelated provider failures', async () => {
    const error = new Error('AccessDenied');
    mocks.provider.mockReturnValue(async () => {
      throw error;
    });
    await expect(resolveAwsTarget({ region: 'us-east-1' })).rejects.toMatchObject({ cause: error });
    expect(mocks.export).not.toHaveBeenCalled();
  });
});
