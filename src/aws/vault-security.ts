import {
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { awsClientConfig, type AwsTarget } from './target.js';
import { parseVaultUri } from './recovery-store.js';

export interface RecoveryKmsKey {
  arn: string;
  id: string;
}
export interface VaultSecurity {
  s3Key?: RecoveryKmsKey;
  secretKey?: RecoveryKmsKey;
}
export function partition(target: AwsTarget): string {
  const value = target.arn.split(':')[1];
  if (!/^aws(?:-[a-z-]+)?$/.test(value ?? ''))
    throw new Error('AWS target has no valid partition identity');
  return value;
}
export function assertSecretArn(target: AwsTarget, arn: string) {
  if (
    !arn.startsWith(
      `arn:${partition(target)}:secretsmanager:${target.region}:${target.account}:secret:`,
    ) ||
    !/^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(arn)
  )
    throw new Error('Recovery secret must be in the selected AWS account and region');
}
const values = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
export function deniesInsecureTransport(value: unknown, bucketArn: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const statements = (value as { Statement?: unknown }).Statement;
  return values(statements).some((item) => {
    if (!item || typeof item !== 'object') return false;
    const statement = item as Record<string, unknown>;
    const principal = statement.Principal;
    const allPrincipals =
      principal === '*' ||
      (principal &&
        typeof principal === 'object' &&
        values((principal as { AWS?: unknown }).AWS).includes('*'));
    const actions = values(statement.Action);
    const resources = values(statement.Resource);
    const condition = statement.Condition;
    if (
      !condition ||
      typeof condition !== 'object' ||
      Object.keys(condition).some((key) => key !== 'Bool')
    )
      return false;
    const bool = (condition as { Bool?: unknown }).Bool;
    if (!bool || typeof bool !== 'object') return false;
    const checks = bool as Record<string, unknown>;
    const isFalse = (field: string) => checks[field] === false || checks[field] === 'false';
    if (
      !isFalse('aws:SecureTransport') ||
      Object.keys(checks).some(
        (key) =>
          key !== 'aws:SecureTransport' && (key !== 'aws:PrincipalIsAWSService' || !isFalse(key)),
      )
    )
      return false;
    return (
      statement.Effect === 'Deny' &&
      allPrincipals &&
      (actions.includes('*') || actions.includes('s3:*')) &&
      (resources.includes('*') ||
        (resources.includes(bucketArn) && resources.includes(`${bucketArn}/*`)))
    );
  });
}
async function kmsKey(target: AwsTarget, id: string, signal: AbortSignal): Promise<RecoveryKmsKey> {
  const client = new KMSClient(awsClientConfig(target));
  try {
    const { KeyMetadata: key } = await client.send(new DescribeKeyCommand({ KeyId: id }), {
      abortSignal: signal,
    });
    if (
      !key?.Arn?.startsWith(
        `arn:${partition(target)}:kms:${target.region}:${target.account}:key/`,
      ) ||
      !key.KeyId ||
      key.KeyState !== 'Enabled' ||
      key.KeyUsage !== 'ENCRYPT_DECRYPT' ||
      key.KeySpec !== 'SYMMETRIC_DEFAULT'
    )
      throw new Error(
        'Recovery encryption requires an enabled symmetric KMS key in the selected account and region',
      );
    return { arn: key.Arn, id: key.KeyId };
  } finally {
    client.destroy();
  }
}

/** Read failures never authorize rewriting a bucket policy, lifecycle or encryption key. */
export async function validateVaultSecurity(
  target: AwsTarget,
  uri: string,
  keyArn: string,
  options: { signal?: AbortSignal } = {},
): Promise<VaultSecurity> {
  assertSecretArn(target, keyArn);
  const location = parseVaultUri(uri);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
    : AbortSignal.timeout(60000);
  const s3 = new S3Client(awsClientConfig(target));
  const secrets = new SecretsManagerClient(awsClientConfig(target));
  const common = { Bucket: location.bucket, ExpectedBucketOwner: target.account };
  try {
    // All checks are independent. Settle every request before destroying clients.
    const results = await Promise.allSettled([
      s3.send(new GetBucketLocationCommand(common), { abortSignal: signal }),
      s3.send(new GetBucketVersioningCommand(common), { abortSignal: signal }),
      s3.send(new GetBucketEncryptionCommand(common), { abortSignal: signal }),
      s3.send(new GetPublicAccessBlockCommand(common), { abortSignal: signal }),
      s3.send(new GetBucketOwnershipControlsCommand(common), { abortSignal: signal }),
      s3.send(new GetBucketPolicyCommand(common), { abortSignal: signal }),
      s3
        .send(new GetBucketLifecycleConfigurationCommand(common), { abortSignal: signal })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'NoSuchLifecycleConfiguration') return {};
          throw error;
        }),
      secrets.send(new DescribeSecretCommand({ SecretId: keyArn }), { abortSignal: signal }),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const value = <T>(index: number) => (results[index] as PromiseFulfilledResult<T>).value;
    const actual = value<{ LocationConstraint?: string }>(0).LocationConstraint;
    const region = actual === 'EU' ? 'eu-west-1' : actual || 'us-east-1';
    if (region !== target.region) throw new Error('Recovery bucket is in a different AWS region');
    if (value<{ Status?: string }>(1).Status !== 'Enabled')
      throw new Error('Recovery bucket versioning must be enabled');
    const encryption = value<{
      ServerSideEncryptionConfiguration?: {
        Rules?: {
          ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string; KMSMasterKeyID?: string };
        }[];
      };
    }>(2).ServerSideEncryptionConfiguration?.Rules;
    if (
      encryption?.length !== 1 ||
      !['AES256', 'aws:kms', 'aws:kms:dsse'].includes(
        encryption[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? '',
      )
    )
      throw new Error('Recovery bucket must have explicit supported default encryption');
    const block = value<{ PublicAccessBlockConfiguration?: Record<string, boolean> }>(
      3,
    ).PublicAccessBlockConfiguration;
    if (
      !block ||
      !['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets'].every(
        (key) => block[key] === true,
      )
    )
      throw new Error('Recovery bucket must block all public access');
    if (
      value<{ OwnershipControls?: { Rules?: { ObjectOwnership?: string }[] } }>(4).OwnershipControls
        ?.Rules?.[0]?.ObjectOwnership !== 'BucketOwnerEnforced'
    )
      throw new Error('Recovery bucket must enforce bucket-owner object ownership');
    const policy = value<{ Policy?: string }>(5).Policy;
    if (
      !policy ||
      !deniesInsecureTransport(
        JSON.parse(policy),
        `arn:${partition(target)}:s3:::${location.bucket}`,
      )
    )
      throw new Error(
        'Recovery bucket policy must deny insecure transport for the bucket and all objects',
      );
    const lifecycle =
      value<{
        Rules?: {
          Status?: string;
          Prefix?: string;
          Filter?: { Prefix?: string; And?: { Prefix?: string } };
          Expiration?: unknown;
          NoncurrentVersionExpiration?: unknown;
          Transitions?: unknown[];
          NoncurrentVersionTransitions?: unknown[];
        }[];
      }>(6).Rules ?? [];
    for (const rule of lifecycle) {
      const prefix = rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? '';
      const overlaps =
        location.prefix.startsWith(prefix) ||
        prefix.startsWith(`${location.prefix}/`) ||
        prefix === location.prefix;
      if (
        rule.Status === 'Enabled' &&
        overlaps &&
        (rule.Expiration ||
          rule.NoncurrentVersionExpiration ||
          rule.Transitions?.length ||
          rule.NoncurrentVersionTransitions?.length)
      )
        throw new Error(
          'Recovery prefix has an expiry or storage-transition policy; remove it or select a prefix with indefinite immediately readable retention',
        );
    }
    const secret = value<{ ARN?: string; DeletedDate?: Date; KmsKeyId?: string }>(7);
    if (secret.ARN !== keyArn || secret.DeletedDate)
      throw new Error('Independent recovery secret is missing or scheduled for deletion');
    const defaultEncryption = encryption[0].ApplyServerSideEncryptionByDefault!;
    return {
      ...(defaultEncryption.SSEAlgorithm !== 'AES256'
        ? {
            s3Key: await kmsKey(target, defaultEncryption.KMSMasterKeyID ?? 'alias/aws/s3', signal),
          }
        : {}),
      ...(secret.KmsKeyId ? { secretKey: await kmsKey(target, secret.KmsKeyId, signal) } : {}),
    };
  } finally {
    s3.destroy();
    secrets.destroy();
  }
}
