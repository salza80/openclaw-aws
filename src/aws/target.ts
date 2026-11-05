import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { execa } from 'execa';
import { AWSError } from '../cli/utils/errors.js';

// SDKs and child processes receive the same resolved credentials. No operation
// selects a profile by changing process.env, including overlapping operations.
type Credentials = Awaited<ReturnType<ReturnType<typeof defaultProvider>>>;
export interface AwsTarget {
  readonly region: string;
  readonly profile?: string;
  readonly account: string;
  readonly arn: string;
  readonly userId: string;
  readonly credentials: () => Promise<Credentials>;
  environment(minimumValidityMs?: number): Promise<Record<string, string | undefined>>;
}
export type AwsLocation = string | AwsTarget;

export function awsRegion(target: AwsLocation): string {
  return typeof target === 'string' ? target : target.region;
}
export function awsClientConfig(target: AwsLocation) {
  return typeof target === 'string'
    ? { region: target }
    : { region: target.region, credentials: target.credentials };
}

async function identify(region: string, credentials: Credentials) {
  const client = new STSClient({ region, credentials });
  try {
    const identity = await client.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !identity.Arn || !identity.UserId) {
      throw new AWSError('AWS returned an incomplete caller identity');
    }
    return { account: identity.Account, arn: identity.Arn, userId: identity.UserId };
  } finally {
    client.destroy();
  }
}

export async function resolveAwsTarget(options: {
  region: string;
  profile?: string;
}): Promise<AwsTarget> {
  const region = options.region;
  const environment = { ...process.env };
  const profile = options.profile ?? environment.AWS_PROFILE ?? environment.AWS_DEFAULT_PROFILE;
  const environmentCredentials =
    !profile && environment.AWS_ACCESS_KEY_ID && environment.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: environment.AWS_ACCESS_KEY_ID,
          secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
          sessionToken: environment.AWS_SESSION_TOKEN,
          expiration: environment.AWS_CREDENTIAL_EXPIRATION
            ? new Date(environment.AWS_CREDENTIAL_EXPIRATION)
            : undefined,
        }
      : undefined;
  const provider = defaultProvider({
    profile: profile ?? 'default',
    filepath: environment.AWS_SHARED_CREDENTIALS_FILE,
    configFilepath: environment.AWS_CONFIG_FILE,
  });
  const load = async (forceRefresh = false): Promise<Credentials> => {
    if (environmentCredentials) return environmentCredentials;
    try {
      return await provider({ forceRefresh });
    } catch (error) {
      // AWS CLI can still have an unexpired SSO role credential after the login
      // session expires. Export privately rather than allowing SDK/CLI drift.
      if (!/sso|single.sign.on/i.test(error instanceof Error ? error.message : '')) {
        const failure = new AWSError('Unable to resolve AWS credentials for the selected profile', [
          'Check AWS credential configuration and refresh the selected session',
        ]);
        failure.cause = error;
        throw failure;
      }
      try {
        const result = await execa(
          'aws',
          [
            'configure',
            'export-credentials',
            '--profile',
            profile ?? 'default',
            '--format',
            'process',
          ],
          {
            env: { ...environment, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
            extendEnv: false,
            timeout: 15000,
            maxBuffer: 16384,
          },
        );
        const value = JSON.parse(result.stdout);
        if (
          typeof value.AccessKeyId !== 'string' ||
          typeof value.SecretAccessKey !== 'string' ||
          typeof value.SessionToken !== 'string' ||
          typeof value.Expiration !== 'string'
        )
          throw new Error('Incomplete export', { cause: error });
        return {
          accessKeyId: value.AccessKeyId,
          secretAccessKey: value.SecretAccessKey,
          sessionToken: value.SessionToken,
          expiration: new Date(value.Expiration),
        };
      } catch {
        throw new AWSError(`AWS credentials unavailable for profile '${profile ?? 'default'}'`, [
          `Sign in again: aws sso login --profile ${profile ?? 'default'}`,
        ]);
      }
    }
  };
  let current = await load();
  const identity = await identify(region, current);
  let refresh: Promise<Credentials> | undefined;
  const getCredentials = async (minimumValidityMs = 60_000): Promise<Credentials> => {
    const valid = (credentials: Credentials) =>
      !credentials.expiration ||
      (Number.isFinite(credentials.expiration.getTime()) &&
        credentials.expiration.getTime() - Date.now() > minimumValidityMs);
    if (valid(current)) return current;
    refresh ??= (async () => {
      const next = await load(true);
      const nextIdentity = await identify(region, next);
      if (nextIdentity.account !== identity.account || nextIdentity.arn !== identity.arn) {
        throw new AWSError(
          'AWS identity changed during this operation; retry with the intended profile',
        );
      }
      current = next;
      return next;
    })().finally(() => {
      refresh = undefined;
    });
    const next = await refresh;
    if (!valid(next))
      throw new AWSError('AWS credentials expire too soon for this operation', [
        `Refresh credentials${profile ? `: aws sso login --profile ${profile}` : ' and retry'}`,
      ]);
    return next;
  };
  return Object.freeze({
    region: region,
    profile,
    ...identity,
    credentials: async () => {
      const value = await getCredentials();
      return { ...value, expiration: value.expiration ? new Date(value.expiration) : undefined };
    },
    environment: async (minimumValidityMs = 60_000) => {
      const credentials = await getCredentials(minimumValidityMs);
      return {
        ...environment,
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_SESSION_TOKEN: credentials.sessionToken,
        AWS_CREDENTIAL_EXPIRATION: credentials.expiration?.toISOString(),
        AWS_PROFILE: undefined,
        AWS_DEFAULT_PROFILE: undefined,
        AWS_ROLE_ARN: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
      };
    },
  });
}
