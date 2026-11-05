import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnPolicy, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { createHash } from 'node:crypto';

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
      !/^[a-zA-Z0-9/_-]+$/.test(props.dataPrefix) ||
      props.dataPrefix.split('/').some((part) => !part)
    )
      throw new Error('Invalid recovery access scope');
    const keyParts = props.keyArn.split(':');
    if (
      !/^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(
        props.keyArn,
      ) ||
      keyParts[3] !== props.env?.region ||
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
            's3:PutObject',
            's3:PutObjectTagging',
            's3:AbortMultipartUpload',
            's3:ListMultipartUploadParts',
          ],
          resources: [`${bucketArn}/${prefix}/*`],
        }),
        new PolicyStatement({
          actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          resources: [
            `${bucketArn}/${prefix}/_probes/*`,
            `${bucketArn}/${prefix}/.openclaw-probe-*`,
          ],
        }),
        new PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.keyArn],
        }),
      ],
    });
    new CfnPolicy(this, 'RecoveryAccess', {
      policyName: `OpenclawRecovery-${createHash('sha256').update(this.stackName).digest('hex').slice(0, 32)}`,
      roles: [props.roleName],
      policyDocument: document.toJSON(),
    });
  }
}
