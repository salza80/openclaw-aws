import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ s3: vi.fn(), kms: vi.fn(), secrets: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send = mocks.s3;
    destroy = mocks.destroy;
  },
}));
vi.mock('@aws-sdk/client-kms', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-kms')>()),
  KMSClient: class {
    send = mocks.kms;
    destroy = mocks.destroy;
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-secrets-manager')>()),
  SecretsManagerClient: class {
    send = mocks.secrets;
    destroy = mocks.destroy;
  },
}));
import { deniesInsecureTransport, validateVaultSecurity } from '../../src/aws/vault-security.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const target = {
  ...testTarget,
  region: 'eu-central-1',
  arn: 'arn:aws:iam::123456789012:role/operator',
};
const uri = 's3://private-backups/vault/main';
const keyArn = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:independent-abcdef';
const bucketArn = 'arn:aws:s3:::private-backups';
const tlsPolicy = {
  Statement: [
    {
      Effect: 'Deny',
      Principal: '*',
      Action: 's3:*',
      Resource: [bucketArn, `${bucketArn}/*`],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ],
};
let replies: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  replies = {
    GetBucketLocationCommand: { LocationConstraint: 'eu-central-1' },
    GetBucketVersioningCommand: { Status: 'Enabled' },
    GetBucketEncryptionCommand: {
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    },
    GetPublicAccessBlockCommand: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
    GetBucketOwnershipControlsCommand: {
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    },
    GetBucketPolicyCommand: { Policy: JSON.stringify(tlsPolicy) },
    GetBucketLifecycleConfigurationCommand: {},
  };
  mocks.s3.mockImplementation(async (command) => {
    const result = replies[command.constructor.name];
    if (result instanceof Error) throw result;
    return result;
  });
  mocks.secrets.mockResolvedValue({ ARN: keyArn });
});
describe('recovery vault AWS guardrails', () => {
  it('checks region, versioning, encryption, ownership, public access, TLS and retention without mutations', async () => {
    expect(await validateVaultSecurity(target, uri, keyArn)).toEqual({});
    expect(mocks.s3).toHaveBeenCalledTimes(7);
    for (const [command] of mocks.s3.mock.calls)
      expect(command.input).toMatchObject({
        Bucket: 'private-backups',
        ExpectedBucketOwner: target.account,
      });
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['GetBucketLocationCommand', { LocationConstraint: 'us-east-2' }, /different AWS region/],
    ['GetBucketVersioningCommand', { Status: 'Suspended' }, /versioning/],
    ['GetBucketEncryptionCommand', {}, /encryption/],
    [
      'GetPublicAccessBlockCommand',
      { PublicAccessBlockConfiguration: { BlockPublicAcls: true } },
      /public/,
    ],
    [
      'GetBucketOwnershipControlsCommand',
      { OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] } },
      /ownership/,
    ],
    ['GetBucketPolicyCommand', { Policy: '{"Statement":[]}' }, /insecure transport/],
    [
      'GetBucketLifecycleConfigurationCommand',
      { Rules: [{ Status: 'Enabled', Expiration: { Days: 1 } }] },
      /expiry/,
    ],
    [
      'GetBucketLifecycleConfigurationCommand',
      {
        Rules: [
          {
            Status: 'Enabled',
            Filter: { Prefix: 'vault/main/native/' },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          },
        ],
      },
      /expiry/,
    ],
    [
      'GetBucketLifecycleConfigurationCommand',
      {
        Rules: [
          {
            Status: 'Enabled',
            Filter: { And: { Prefix: 'vault/', Tags: [{ Key: 'x', Value: 'y' }] } },
            Transitions: [{ Days: 10, StorageClass: 'GLACIER' }],
          },
        ],
      },
      /storage-transition/,
    ],
  ] as const)('rejects unsafe %s configuration', async (command, result, message) => {
    replies[command] = result;
    await expect(validateVaultSecurity(target, uri, keyArn)).rejects.toThrow(message);
  });
  it('allows unrelated lifecycle policies and abort-only rules', async () => {
    replies.GetBucketLifecycleConfigurationCommand = {
      Rules: [
        { Status: 'Enabled', Filter: { Prefix: 'elsewhere/' }, Expiration: { Days: 1 } },
        { Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
      ],
    };
    expect(await validateVaultSecurity(target, uri, keyArn)).toEqual({});
  });
  it('recognizes only a genuinely absent lifecycle configuration and preserves access errors', async () => {
    replies.GetBucketLifecycleConfigurationCommand = Object.assign(new Error('none'), {
      name: 'NoSuchLifecycleConfiguration',
    });
    expect(await validateVaultSecurity(target, uri, keyArn)).toEqual({});
    const error = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    replies.GetBucketLifecycleConfigurationCommand = error;
    await expect(validateVaultSecurity(target, uri, keyArn)).rejects.toBe(error);
  });
  it('does not accept a narrowed TLS deny rule as global protection', () => {
    expect(deniesInsecureTransport(tlsPolicy, bucketArn)).toBe(true);
    expect(
      deniesInsecureTransport(
        { Statement: [{ ...tlsPolicy.Statement[0], Resource: bucketArn }] },
        bucketArn,
      ),
    ).toBe(false);
    expect(
      deniesInsecureTransport(
        {
          Statement: [
            {
              ...tlsPolicy.Statement[0],
              Condition: {
                Bool: { 'aws:SecureTransport': 'false' },
                StringEquals: { 'aws:PrincipalArn': 'one-role' },
              },
            },
          ],
        },
        bucketArn,
      ),
    ).toBe(false);
    expect(
      deniesInsecureTransport(
        {
          Statement: [
            {
              ...tlsPolicy.Statement[0],
              Condition: {
                Bool: { 'aws:SecureTransport': 'false', 'aws:PrincipalIsAWSService': 'false' },
              },
            },
          ],
        },
        bucketArn,
      ),
    ).toBe(true);
  });
  it('resolves supported customer KMS keys and retains their concrete identities', async () => {
    replies.GetBucketEncryptionCommand = {
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
              KMSMasterKeyID: 'alias/recovery',
            },
          },
        ],
      },
    };
    mocks.secrets.mockResolvedValue({ ARN: keyArn, KmsKeyId: 'alias/secret-key' });
    const kms = {
      Arn: 'arn:aws:kms:eu-central-1:123456789012:key/11111111-1111-1111-1111-111111111111',
      KeyId: '11111111-1111-1111-1111-111111111111',
      KeyState: 'Enabled',
      KeyUsage: 'ENCRYPT_DECRYPT',
      KeySpec: 'SYMMETRIC_DEFAULT',
    };
    mocks.kms.mockResolvedValue({ KeyMetadata: kms });
    expect(await validateVaultSecurity(target, uri, keyArn)).toEqual({
      s3Key: { arn: kms.Arn, id: kms.KeyId },
      secretKey: { arn: kms.Arn, id: kms.KeyId },
    });
    expect(mocks.kms.mock.calls.map(([command]) => command.input.KeyId)).toEqual([
      'alias/recovery',
      'alias/secret-key',
    ]);
    mocks.kms.mockResolvedValue({ KeyMetadata: { ...kms, KeyState: 'PendingDeletion' } });
    await expect(validateVaultSecurity(target, uri, keyArn)).rejects.toThrow(/enabled symmetric/);
  });
  it('rejects secret deletion and foreign references before they become recovery prerequisites', async () => {
    mocks.secrets.mockResolvedValue({ ARN: keyArn, DeletedDate: new Date() });
    await expect(validateVaultSecurity(target, uri, keyArn)).rejects.toThrow(
      /scheduled for deletion/,
    );
    vi.clearAllMocks();
    await expect(
      validateVaultSecurity(target, uri, keyArn.replace('123456789012', '999999999999')),
    ).rejects.toThrow(/selected AWS account/);
    expect(mocks.s3).not.toHaveBeenCalled();
  });
});
