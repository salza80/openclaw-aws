import { createHash } from 'node:crypto';
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import type { AwsTarget } from '../aws/target.js';
import { awsClientConfig } from '../aws/target.js';
import { parseVaultUri, recoveryStore } from '../aws/recovery-store.js';
import {
  assertSecretArn,
  validateVaultSecurity,
  type RecoveryKmsKey,
  type VaultSecurity,
  partition,
} from '../aws/vault-security.js';
import { ensureRecoveryStack } from '../aws/auxiliary-stacks.js';

export interface RecoveryVault {
  schemaVersion: 1;
  kind: 'openclaw-aws-vault';
  id: string;
  uri: string;
  account: string;
  region: string;
  createdAt: string;
  key: { arn: string; versionId: string; versionStage: string };
  encryption: VaultSecurity;
  retention: 'indefinite';
  managedStackId?: string;
}
const canonicalUri = (uri: string) => {
  const location = parseVaultUri(uri);
  return `s3://${location.bucket}/${location.prefix}`;
};
export const vaultId = (target: AwsTarget, uri: string, arn: string) =>
  createHash('sha256')
    .update(JSON.stringify([target.account, target.region, canonicalUri(uri), arn]))
    .digest('hex')
    .slice(0, 32);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery vault metadata');
  return value as Record<string, unknown>;
}
function kmsReference(value: unknown, target: AwsTarget): RecoveryKmsKey | undefined {
  if (value === undefined) return undefined;
  const key = record(value);
  if (
    typeof key.arn !== 'string' ||
    !key.arn.startsWith(`arn:${partition(target)}:kms:${target.region}:${target.account}:key/`) ||
    !/^arn:[a-z0-9-]+:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(key.arn) ||
    key.arn.split(':')[3] !== target.region ||
    key.arn.split(':')[4] !== target.account ||
    typeof key.id !== 'string' ||
    key.id !== key.arn.split('/').at(-1)
  )
    throw new Error('Invalid independent KMS key reference');
  return { arn: key.arn, id: key.id };
}
export function parseRecoveryVault(value: unknown, target: AwsTarget, uri: string): RecoveryVault {
  const data = record(value);
  const key = record(data.key);
  const encryption = record(data.encryption);
  if (
    data.schemaVersion !== 1 ||
    data.kind !== 'openclaw-aws-vault' ||
    data.uri !== canonicalUri(uri) ||
    data.account !== target.account ||
    data.region !== target.region ||
    data.retention !== 'indefinite' ||
    typeof data.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    new Date(data.createdAt).toISOString() !== data.createdAt ||
    typeof key.arn !== 'string' ||
    typeof key.versionId !== 'string' ||
    !/^[A-Za-z0-9-]{32,64}$/.test(key.versionId)
  )
    throw new Error('Recovery vault metadata does not match this AWS target and locator');
  assertSecretArn(target, key.arn);
  const id = vaultId(target, uri, key.arn);
  if (data.id !== id || key.versionStage !== `openclaw-aws-vault-${id}`)
    throw new Error('Recovery vault key identity is inconsistent');
  if (
    data.managedStackId !== undefined &&
    (typeof data.managedStackId !== 'string' ||
      !/^arn:[a-z0-9-]+:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/.test(
        data.managedStackId,
      ) ||
      data.managedStackId.split(':')[3] !== target.region ||
      data.managedStackId.split(':')[4] !== target.account)
  )
    throw new Error('Invalid independent vault stack identity');
  return {
    schemaVersion: 1,
    kind: 'openclaw-aws-vault',
    id,
    uri: data.uri as string,
    account: target.account,
    region: target.region,
    createdAt: data.createdAt,
    key: { arn: key.arn, versionId: key.versionId, versionStage: key.versionStage as string },
    encryption: {
      ...(encryption.s3Key !== undefined ? { s3Key: kmsReference(encryption.s3Key, target) } : {}),
      ...(encryption.secretKey !== undefined
        ? { secretKey: kmsReference(encryption.secretKey, target) }
        : {}),
    },
    retention: 'indefinite',
    ...(data.managedStackId ? { managedStackId: data.managedStackId as string } : {}),
  };
}

/** Works with just an operator target and vault URI, without source/laptop configuration. */
export async function readRecoveryVault(target: AwsTarget, uri: string): Promise<RecoveryVault> {
  const store = recoveryStore(target, uri);
  try {
    const result = await store.read('vault.json', { signal: AbortSignal.timeout(30000) });
    if (!result) throw new Error('Recovery vault is not registered at this locator');
    return parseRecoveryVault(result.value, target, uri);
  } finally {
    store.close();
  }
}

/** Secret material is only passed to native encryption, never added to receipts or output. */
export async function recoveryPassphrase(target: AwsTarget, vault: RecoveryVault): Promise<string> {
  const client = new SecretsManagerClient(awsClientConfig(target));
  try {
    const result = await client.send(
      new GetSecretValueCommand({
        SecretId: vault.key.arn,
        VersionId: vault.key.versionId,
        VersionStage: vault.key.versionStage,
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    if (
      result.ARN !== vault.key.arn ||
      result.VersionId !== vault.key.versionId ||
      !result.SecretString
    )
      throw new Error('Independent recovery key version could not be resolved');
    return result.SecretString;
  } finally {
    client.destroy();
  }
}

export async function registerRecoveryVault(
  target: AwsTarget,
  options: { uri: string; keyArn: string; managedStackId?: string },
): Promise<RecoveryVault> {
  const uri = canonicalUri(options.uri);
  const encryption = await validateVaultSecurity(target, uri, options.keyArn);
  const store = recoveryStore(target, uri);
  const secrets = new SecretsManagerClient(awsClientConfig(target));
  const signal = AbortSignal.timeout(60000);
  try {
    const existing = await store.read('vault.json', { signal });
    if (existing) {
      const vault = parseRecoveryVault(existing.value, target, uri);
      if (
        vault.key.arn !== options.keyArn ||
        vault.managedStackId !== options.managedStackId ||
        JSON.stringify(vault.encryption) !== JSON.stringify(encryption)
      )
        throw new Error(
          'Registered vault identity or encryption changed; inspect it before selecting a new recovery destination',
        );
      await recoveryPassphrase(target, vault);
      return vault;
    }
    const id = vaultId(target, uri, options.keyArn);
    const versionStage = `openclaw-aws-vault-${id}`;
    const described = await secrets.send(new DescribeSecretCommand({ SecretId: options.keyArn }), {
      abortSignal: signal,
    });
    const pinned = Object.entries(described.VersionIdsToStages ?? {}).find(([, stages]) =>
      stages.includes(versionStage),
    )?.[0];
    const material = await secrets.send(
      new GetSecretValueCommand({
        SecretId: options.keyArn,
        ...(pinned ? { VersionId: pinned } : { VersionStage: 'AWSCURRENT' }),
      }),
      { abortSignal: signal },
    );
    if (material.ARN !== options.keyArn || !material.VersionId || !material.SecretString)
      throw new Error('Recovery secret must contain an independently retained string passphrase');
    // A labeled version is protected from Secrets Manager's unlabeled-version collection.
    // Omit RemoveFromVersionId: a racing registration must never move an existing label.
    await secrets.send(
      new UpdateSecretVersionStageCommand({
        SecretId: options.keyArn,
        VersionStage: versionStage,
        MoveToVersionId: material.VersionId,
      }),
      { abortSignal: signal },
    );
    const vault = parseRecoveryVault(
      {
        schemaVersion: 1,
        kind: 'openclaw-aws-vault',
        id,
        uri,
        account: target.account,
        region: target.region,
        createdAt: new Date().toISOString(),
        key: { arn: options.keyArn, versionId: material.VersionId, versionStage },
        encryption,
        retention: 'indefinite',
        ...(options.managedStackId ? { managedStackId: options.managedStackId } : {}),
      },
      target,
      uri,
    );
    await store.putImmutable('vault.json', vault, { signal });
    await recoveryPassphrase(target, vault);
    return vault;
  } finally {
    store.close();
    secrets.destroy();
  }
}

export async function createRecoveryVault(target: AwsTarget, name: string): Promise<RecoveryVault> {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name))
    throw new Error(
      'Vault name must use 1–48 lowercase letters, digits or hyphens, beginning with a letter',
    );
  const stack = await ensureRecoveryStack(target, {
    kind: 'recovery-vault',
    stackName: `OpenclawVault-${name}`,
    identity: name,
    vaultName: name,
  });
  const uri = stack.Outputs?.find((output) => output.OutputKey === 'VaultUri')?.OutputValue;
  const keyArn = stack.Outputs?.find((output) => output.OutputKey === 'KeyArn')?.OutputValue;
  if (!uri || !keyArn || !stack.StackId)
    throw new Error('Independent vault stack did not return complete recovery identities');
  return registerRecoveryVault(target, { uri, keyArn, managedStackId: stack.StackId });
}
