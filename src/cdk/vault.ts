import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnRolePolicy, PolicyDocument, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/** An independent stack: source deployment destruction cannot delete recovery state. */
export class RecoveryVaultStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { vaultName: string }) {
    super(scope, id, props);
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(props.vaultName))
      throw new Error('Invalid recovery vault name');
    const bucket = new Bucket(this, 'RecoveryObjects', {
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      // No expiry for completed objects or noncurrent versions.
      lifecycleRules: [
        { id: 'AbortIncompleteUploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });
    const key = new Secret(this, 'RecoveryPassphrase', {
      description:
        'Independent OpenClaw native storage passphrase. Retain for every recovery point.',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    key.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const prefix = `openclaw-aws/vaults/${props.vaultName}`;
    new CfnOutput(this, 'VaultUri', { value: `s3://${bucket.bucketName}/${prefix}` });
    new CfnOutput(this, 'KeyArn', { value: key.secretArn });
  }
}

export interface RecoveryAccessProps extends StackProps {
  roleName: string;
  bucket: string;
  dataPrefix: string;
  keyArn: string;
  s3KmsKeyArn?: string;
  secretKmsKeyArn?: string;
  mode?: 'capture' | 'read';
  recoveryRegion?: string;
  secretImport?: {
    deploymentName: string;
    deploymentId: string;
    operationId: string;
    readOnly?: true;
  };
}

/** Attach only after verifying this role belongs to the selected source stack.
 * No imports/exports or source-template changes: remove this stack before its source.
 */
export class RecoveryAccessStack extends Stack {
  constructor(scope: Construct, id: string, props: RecoveryAccessProps) {
    super(scope, id, props);
    if (!/^[\w+=,.@-]{1,64}$/.test(props.roleName)) throw new Error('Invalid deployment role name');
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(props.bucket) ||
      typeof props.dataPrefix !== 'string' ||
      props.dataPrefix.startsWith('/') ||
      /[\\%?#*$]/.test(props.dataPrefix) ||
      [...props.dataPrefix].some((char) => char.charCodeAt(0) < 32) ||
      Buffer.byteLength(props.dataPrefix, 'utf8') > 768 ||
      props.dataPrefix.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid recovery access scope');
    if (props.mode !== undefined && !['capture', 'read'].includes(props.mode))
      throw new Error('Invalid recovery access mode');
    const readOnly = props.mode === 'read';
    const recoveryRegion = props.recoveryRegion ?? props.env?.region;
    if (
      !recoveryRegion ||
      !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(recoveryRegion) ||
      (!readOnly && recoveryRegion !== props.env?.region)
    )
      throw new Error('Recovery access region is invalid for this mode');
    const keyParts = props.keyArn.split(':');
    if (
      !/^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(
        props.keyArn,
      ) ||
      keyParts[3] !== recoveryRegion ||
      keyParts[4] !== props.env?.account
    )
      throw new Error('Recovery key must belong to the selected AWS account and region');
    const bucketArn = `arn:${this.partition}:s3:::${props.bucket}`;
    const prefix = props.dataPrefix;
    const document = new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [bucketArn],
          conditions: { StringLike: { 's3:prefix': [`${prefix}/`, `${prefix}/*`] } },
        }),
        new PolicyStatement({
          actions: [
            's3:GetObject',
            's3:GetObjectVersion',
            's3:GetObjectTagging',
            's3:GetObjectVersionTagging',
            ...(readOnly
              ? []
              : [
                  's3:PutObject',
                  's3:PutObjectTagging',
                  's3:AbortMultipartUpload',
                  's3:ListMultipartUploadParts',
                ]),
          ],
          resources: [`${bucketArn}/${prefix}/*`],
        }),
        ...(readOnly
          ? []
          : [
              new PolicyStatement({
                actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
                resources: [
                  `${bucketArn}/${prefix}/_probes/*`,
                  `${bucketArn}/${prefix}/.openclaw-probe-*`,
                ],
              }),
            ]),
        new PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.keyArn],
        }),
      ],
    });
    for (const [keyArn, service, context] of [
      [
        props.s3KmsKeyArn,
        's3',
        { 'kms:EncryptionContext:aws:s3:arn': [bucketArn, `${bucketArn}/${prefix}/*`] },
      ],
      [
        props.secretKmsKeyArn,
        'secretsmanager',
        { 'kms:EncryptionContext:SecretARN': props.keyArn },
      ],
    ] as const) {
      if (!keyArn) continue;
      const keyParts = keyArn.split(':');
      if (
        !/^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(keyArn) ||
        keyParts[3] !== recoveryRegion ||
        keyParts[4] !== props.env?.account
      )
        throw new Error('Recovery KMS key must belong to the selected AWS account and region');
      document.addStatements(
        new PolicyStatement({
          actions:
            service === 's3' && !readOnly
              ? ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey']
              : ['kms:Decrypt'],
          resources: [keyArn],
          conditions: {
            StringEquals: { 'kms:ViaService': `${service}.${recoveryRegion}.${this.urlSuffix}` },
            StringLike: context,
          },
        }),
      );
    }
    if (props.secretImport) {
      const { deploymentName, deploymentId, operationId } = props.secretImport;
      if (
        !readOnly ||
        !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(deploymentName) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId) ||
        !deploymentId.startsWith(
          `arn:${keyParts[1]}:cloudformation:${props.env?.region}:${props.env?.account}:stack/OpenclawStack-${deploymentName}/`,
        ) ||
        !/^[A-Za-z0-9-]+$/.test(deploymentId.split('/').at(-1) ?? '')
      )
        throw new Error('Secret import must belong to this restore target and operation');
      const resource = this.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: `openclaw/${deploymentName}/providers/*/api-key`,
      });
      if (props.secretImport.readOnly !== undefined && props.secretImport.readOnly !== true)
        throw new Error('Unsupported target credential access mode');
      if (!props.secretImport.readOnly)
        document.addStatements(
          new PolicyStatement({
            actions: ['ssm:PutParameter', 'ssm:AddTagsToResource'],
            resources: [resource],
            conditions: {
              StringEquals: {
                'aws:RequestTag/openclaw-aws:deployment-id': deploymentId,
                'aws:RequestTag/openclaw-aws:restore-id': operationId,
              },
              'ForAllValues:StringEquals': {
                'aws:TagKeys': ['openclaw-aws:deployment-id', 'openclaw-aws:restore-id'],
              },
            },
          }),
          // AWS documents ssm:Overwrite as a String condition, not a Bool.
          // https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-policy-conditions.html
          new PolicyStatement({
            effect: Effect.DENY,
            actions: ['ssm:PutParameter'],
            resources: [resource],
            conditions: { StringEquals: { 'ssm:Overwrite': 'true' } },
          }),
        );
      document.addStatements(
        new PolicyStatement({ actions: ['ssm:ListTagsForResource'], resources: [resource] }),
      );
    }
    new CfnRolePolicy(this, 'RecoveryAccess', {
      // The policy name lets teardown discover its owning independent stack.
      policyName: this.stackName,
      roleName: props.roleName,
      policyDocument: document.toJSON(),
    });
  }
}
