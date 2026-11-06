import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RecoveryAccessStack, RecoveryVaultStack } from '../../src/cdk/vault.js';

const env = { account: '123456789012', region: 'eu-central-1' };
describe('independent recovery infrastructure', () => {
  it('retains the encrypted versioned private bucket and independent decryption key without object expiry', () => {
    const template = Template.fromStack(
      new RecoveryVaultStack(new App(), 'Vault', { env, vaultName: 'primary' }),
    );
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'AbortIncompleteUploads',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
        ],
      },
    });
    for (const type of ['AWS::S3::Bucket', 'AWS::SecretsManager::Secret']) {
      const resources = Object.values(template.findResources(type));
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    }
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
    const [secret] = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secret.Properties).not.toHaveProperty('SecretString');
    template.resourceCountIs('AWS::EC2::Instance', 0);
  });
  it('attaches only prefix-scoped backup access without editing or importing source infrastructure', () => {
    const template = Template.fromStack(
      new RecoveryAccessStack(new App(), 'Access', {
        env,
        roleName: 'verified-source-role',
        bucket: 'private-backups',
        dataPrefix: 'vault/native/source-1',
        keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:recovery-key-abcdef',
      }),
    );
    template.resourceCountIs('AWS::IAM::RolePolicy', 1);
    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::EC2::Instance', 0);
    const [policy] = Object.values(template.findResources('AWS::IAM::RolePolicy'));
    expect(policy.Properties.RoleName).toBe('verified-source-role');
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(
      statements.find((statement: { Action: unknown }) => statement.Action === 's3:ListBucket')
        .Condition,
    ).toEqual({
      StringLike: { 's3:prefix': ['vault/native/source-1/', 'vault/native/source-1/*'] },
    });
    const deletion = statements.find(
      (statement: { Action: string[] }) =>
        Array.isArray(statement.Action) && statement.Action.includes('s3:DeleteObject'),
    );
    const serialized = JSON.stringify(deletion.Resource);
    expect(serialized).toContain('/vault/native/source-1/_probes/*');
    expect(serialized).toContain('/vault/native/source-1/.openclaw-probe-*');
    expect(serialized).not.toContain('/backups/');
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });
  it('rejects wildcard scopes and foreign key accounts/regions', () => {
    for (const extra of [
      { dataPrefix: 'vault/*' },
      { roleName: '*' },
      { keyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:key' },
      { keyArn: 'arn:aws:secretsmanager:eu-central-1:999999999999:secret:key' },
    ]) {
      expect(
        () =>
          new RecoveryAccessStack(new App(), 'BadAccess', {
            env,
            roleName: 'role',
            bucket: 'private-backups',
            dataPrefix: 'vault/native/source-1',
            keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:key',
            ...extra,
          }),
      ).toThrow();
    }
  });
  it('limits KMS access to the backup bucket context and the independent secret', () => {
    const key = 'arn:aws:kms:eu-central-1:123456789012:key/11111111-1111-1111-1111-111111111111';
    const secret = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:recovery-key-abcdef';
    const template = Template.fromStack(
      new RecoveryAccessStack(new App(), 'KmsAccess', {
        env,
        roleName: 'source-role',
        bucket: 'private-backups',
        dataPrefix: 'vault/native/source-1',
        keyArn: secret,
        s3KmsKeyArn: key,
        secretKmsKeyArn: key,
      }),
    );
    const [policy] = Object.values(template.findResources('AWS::IAM::RolePolicy'));
    const statements = policy.Properties.PolicyDocument.Statement;
    const decrypt = statements.filter((entry: { Resource: unknown }) => entry.Resource === key);
    expect(decrypt).toHaveLength(2);
    expect(decrypt[0].Condition.StringLike['kms:EncryptionContext:aws:s3:arn']).toBeDefined();
    expect(decrypt[1].Condition.StringLike['kms:EncryptionContext:SecretARN']).toBe(secret);
    expect(decrypt[1].Action).toBe('kms:Decrypt');
    expect(JSON.stringify(decrypt)).toContain('kms:ViaService');
    expect(policy.Properties.PolicyName).toBe('KmsAccess');
  });
  it('preserves literal dotted and Unicode vault prefixes without introducing IAM policy variables', () => {
    const prefix = 'backups.v1/team α/native/source-1';
    const template = Template.fromStack(
      new RecoveryAccessStack(new App(), 'LiteralPrefix', {
        env,
        roleName: 'source-role',
        bucket: 'private-backups',
        dataPrefix: prefix,
        keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:recovery-key-abcdef',
      }),
    );
    const [policy] = Object.values(template.findResources('AWS::IAM::RolePolicy'));
    expect(policy.Properties.PolicyDocument.Statement[0].Condition.StringLike['s3:prefix']).toEqual(
      [`${prefix}/`, `${prefix}/*`],
    );
    expect(
      () =>
        new RecoveryAccessStack(new App(), 'VariablePrefix', {
          env,
          roleName: 'source-role',
          bucket: 'private-backups',
          dataPrefix: 'vault/${aws:username}',
          keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:recovery-key-abcdef',
        }),
    ).toThrow();
  });
  it('allows cross-region recovery reads without capture writes or encryption permissions', () => {
    const template = Template.fromStack(
      new RecoveryAccessStack(new App(), 'ReadAccess', {
        env: { ...env, region: 'us-east-1' },
        recoveryRegion: env.region,
        mode: 'read',
        roleName: 'target-role',
        bucket: 'private-backups',
        dataPrefix: 'vault/native/source-1',
        keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:key',
        s3KmsKeyArn: 'arn:aws:kms:eu-central-1:123456789012:key/fixture',
      }),
    );
    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).toContain('s3:GetObjectVersion');
    expect(serialized).toContain('kms:Decrypt');
    expect(serialized).toContain('s3.eu-central-1.');
    for (const action of [
      's3:PutObject',
      's3:DeleteObject',
      's3:AbortMultipartUpload',
      'kms:Encrypt',
      'kms:GenerateDataKey',
    ])
      expect(serialized).not.toContain(`"${action}"`);
    expect(
      () =>
        new RecoveryAccessStack(new App(), 'WrongMode', {
          env: { ...env, region: 'us-east-1' },
          recoveryRegion: env.region,
          roleName: 'target-role',
          bucket: 'private-backups',
          dataPrefix: 'vault/native/source-1',
          keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:key',
        }),
    ).toThrow('region');
  });
  it('imports only tagged new target provider secrets and explicitly denies overwrites', () => {
    const deploymentId =
      'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-restored/fixture';
    const secretImport = {
      deploymentName: 'restored',
      deploymentId,
      operationId: '11111111-1111-1111-1111-111111111111',
    };
    const props = {
      env,
      roleName: 'target-role',
      bucket: 'private-backups',
      dataPrefix: 'vault/native/source-1',
      keyArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:key',
      mode: 'read' as const,
      secretImport,
    };
    const template = Template.fromStack(new RecoveryAccessStack(new App(), 'Import', props));
    const [policy] = Object.values(template.findResources('AWS::IAM::RolePolicy'));
    const statements = policy.Properties.PolicyDocument.Statement;
    const allow = statements.find(
      (s: { Action: string[]; Effect: string }) =>
        s.Effect === 'Allow' && Array.isArray(s.Action) && s.Action.includes('ssm:PutParameter'),
    );
    expect(JSON.stringify(allow.Resource)).toContain(
      'parameter/openclaw/restored/providers/*/api-key',
    );
    expect(allow.Condition.StringEquals).toEqual({
      'aws:RequestTag/openclaw-aws:deployment-id': deploymentId,
      'aws:RequestTag/openclaw-aws:restore-id': secretImport.operationId,
    });
    expect(statements).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Action: 'ssm:PutParameter',
        Condition: { StringEquals: { 'ssm:Overwrite': 'true' } },
      }),
    );
    expect(JSON.stringify(allow)).not.toContain('gateway-token');
    for (const extra of [
      { deploymentName: '../other' },
      { deploymentId: deploymentId.replace('restored/', 'other/') },
      { operationId: 'bad' },
    ])
      expect(
        () =>
          new RecoveryAccessStack(new App(), 'InvalidImport', {
            ...props,
            secretImport: { ...secretImport, ...extra },
          }),
      ).toThrow('restore target');
  });
});
