import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { CommandContext } from '../cli/utils/context.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { awsClientConfig, type AwsTarget } from '../aws/target.js';
import { executeSsm } from '../aws/ssm.js';
import { recoveryRemoteCommand } from '../aws/recovery-delivery.js';
import {
  inspectRecoverySource,
  sourceHash,
  sourceAccessIdentity,
  type RecoverySource,
} from '../aws/recovery-source.js';
import { ensureRecoveryStack } from '../aws/auxiliary-stacks.js';
import { uploadRecoveryArtifact, type RecoveryArtifact } from '../aws/recovery-artifact.js';
import { parseVaultUri, recoveryStore } from '../aws/recovery-store.js';
import { validateVaultSecurity } from '../aws/vault-security.js';
import { asUbuntu } from '../openclaw/commands.js';
import {
  parseBackupJob,
  parseCapturedBackup,
  parseVerification,
  object,
  textField,
  type BackupCaptureJob,
  type CapturedBackup,
} from '../openclaw/backup-contract.js';
import { runBackupHelper } from '../openclaw/backup-helper.js';
import { readRecoveryVault, recoveryPassphrase, type RecoveryVault } from './vault.js';
import { withDeploymentLock } from './lock.js';

export interface BackupReceipt {
  schemaVersion: 1;
  kind: 'openclaw-aws-backup';
  id: string;
  vaultId: string;
  vaultUri: string;
  completedAt: string;
  label?: string;
  job: BackupCaptureJob;
  source: RecoverySource;
  capture: CapturedBackup;
}
export const backupOperationId = (value?: string) => {
  const id = value ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new Error('Invalid backup operation ID');
  return id;
};
export function assertIndependentVault(source: RecoverySource, vault: RecoveryVault) {
  const { bucket } = parseVaultUri(vault.uri);
  const references = [
    bucket,
    vault.key.arn,
    vault.encryption.s3Key?.arn,
    vault.encryption.secretKey?.arn,
  ].filter(Boolean);
  if (
    vault.managedStackId === source.stackId ||
    source.resources.some((resource) =>
      references.some(
        (ref) =>
          resource.id === ref ||
          (resource.type === 'AWS::KMS::Key' && ref?.endsWith(`:key/${resource.id}`)),
      ),
    )
  )
    throw new Error(
      'Recovery storage and encryption keys must be owned independently of the source deployment',
    );
}
async function checkVault(target: AwsTarget, uri: string) {
  const vault = await readRecoveryVault(target, uri);
  const actual = await validateVaultSecurity(target, uri, vault.key.arn);
  if (!isDeepStrictEqual(vault.encryption, actual))
    throw new Error('Vault encryption changed since registration');
  await recoveryPassphrase(target, vault);
  return vault;
}

/** Root downloads nonsecret verified files; only Ubuntu executes the native worker. */
export function captureRemoteCommand(
  job: BackupCaptureJob,
  artifact: RecoveryArtifact,
  request: { key: string; versionId: string; sha256: string },
): string {
  return recoveryRemoteCommand({
    operationId: job.operationId,
    region: job.source.region,
    account: job.source.account,
    bucket: job.settings.bucket,
    pluginDirectory: job.pluginDirectory,
    worker: 'worker.js',
    artifact,
    request,
  });
}

function parsedReceipt(
  value: unknown,
  target: AwsTarget,
  vault: RecoveryVault,
  id: string,
): BackupReceipt {
  const row = object(value);
  if (
    row.kind !== 'openclaw-aws-backup' ||
    row.schemaVersion !== 1 ||
    row.id !== id ||
    row.vaultId !== vault.id ||
    row.vaultUri !== vault.uri
  )
    throw new Error('Recovery receipt does not match this vault and recovery point');
  const job = parseBackupJob(row.job);
  const location = parseVaultUri(vault.uri);
  if (
    job.operationId !== id ||
    job.source.account !== target.account ||
    job.source.region !== target.region ||
    job.settings.bucket !== location.bucket ||
    job.settings.prefix !== `${location.prefix}/native/${sourceHash(job.source.stackId)}` ||
    !isDeepStrictEqual(job.key, vault.key)
  )
    throw new Error('Recovery receipt has inconsistent AWS identities');
  const source = object(row.source);
  const role = object(source.role);
  const profile = object(source.profile);
  const instance = object(source.instance);
  if (!Number.isSafeInteger(instance.minimumDiskGiB) || (instance.minimumDiskGiB as number) < 1)
    throw new Error('Recovery receipt has no source disk capacity');
  if (
    source.stackId !== job.source.stackId ||
    source.instanceId !== job.source.instanceId ||
    role.id !== job.source.roleId
  )
    throw new Error('Recovery receipt source ownership is inconsistent');
  const completedAt = textField(row.completedAt, 64);
  if (!Number.isFinite(Date.parse(completedAt)))
    throw new Error('Invalid recovery completion time');
  return {
    schemaVersion: 1,
    kind: 'openclaw-aws-backup',
    id,
    vaultId: vault.id,
    vaultUri: vault.uri,
    completedAt,
    ...(row.label !== undefined ? { label: textField(row.label, 128) } : {}),
    job,
    source: {
      stackId: job.source.stackId,
      stackName: textField(source.stackName, 128),
      instanceId: job.source.instanceId,
      role: {
        id: job.source.roleId,
        name: textField(role.name, 64),
        arn: textField(role.arn, 2048),
      },
      profile: { arn: textField(profile.arn, 2048), id: textField(profile.id, 128) },
      instance: {
        type: textField(instance.type, 64),
        imageId: textField(instance.imageId, 64),
        subnetId: textField(instance.subnetId, 64),
        vpcId: textField(instance.vpcId, 64),
        architecture: textField(instance.architecture, 64),
        minimumDiskGiB: instance.minimumDiskGiB as number,
      },
      // AWS ownership inventory is needed while creating the point, not for replay.
      resources: [],
    },
    capture: parseCapturedBackup(row.capture, job),
  };
}
export async function inspectBackup(
  target: AwsTarget,
  uri: string,
  id: string,
): Promise<BackupReceipt> {
  backupOperationId(id);
  const vault = await readRecoveryVault(target, uri);
  const store = recoveryStore(target, uri);
  try {
    return await readPoint(store, target, vault, id);
  } finally {
    store.close();
  }
}
async function readPoint(
  store: ReturnType<typeof recoveryStore>,
  target: AwsTarget,
  vault: RecoveryVault,
  id: string,
) {
  const result = await store.read(`receipts/${id}.json`, { signal: AbortSignal.timeout(30000) });
  if (!result) throw new Error('No completed recovery point exists with this ID');
  return parsedReceipt(result.value, target, vault, id);
}

/** Shared operation for CLI/UI/archive. The caller approves this concrete plan. */
export async function createBackup(
  ctx: CommandContext,
  options: {
    vaultUri: string;
    operationId?: string;
    label?: string;
    progress?: (message: string) => void;
  },
): Promise<BackupReceipt> {
  const id = backupOperationId(options.operationId);
  if (options.label !== undefined) textField(options.label, 128);
  return withDeploymentLock(ctx, async () => {
    const vault = await checkVault(ctx.target, options.vaultUri);
    const store = recoveryStore(ctx.target, vault.uri);
    try {
      const completed = await store.read(`receipts/${id}.json`, {
        signal: AbortSignal.timeout(30000),
      });
      if (completed) {
        const existing = parsedReceipt(completed.value, ctx.target, vault, id);
        if (existing.source.stackName !== ctx.config.stack.name)
          throw new Error('This recovery point belongs to another deployment');
        return existing;
      }
      const source = await inspectRecoverySource(ctx);
      assertIndependentVault(source, vault);
      const preflight = await executeSsm(
        source.instanceId,
        ctx.target,
        [asUbuntu('node -p process.versions.node\nopenclaw --version')],
        { executionSeconds: 60 },
      );
      const versions = preflight.stdout.split('\n');
      if (
        versions.length !== 2 ||
        versions[0] !== OPENCLAW_NODE_VERSION ||
        !versions[1].startsWith(`OpenClaw ${OPENCLAW_VERSION} (`)
      )
        throw new Error(
          `Backup requires the supported OpenClaw ${OPENCLAW_VERSION} / Node ${OPENCLAW_NODE_VERSION}; existing instances are not implicitly upgraded`,
        );
      const location = parseVaultUri(vault.uri);
      const dataPrefix = `${location.prefix}/native/${sourceHash(source.stackId)}`;
      options.progress?.(`Preparing prefix-scoped backup access; operation ${id}`);
      await ensureRecoveryStack(ctx.target, {
        kind: 'recovery-access',
        stackName: `OpenclawRecovery-${sourceHash(source.stackId)}-${vault.id.slice(0, 16)}`,
        identity: sourceAccessIdentity(source.stackId, source.role.id),
        access: {
          roleName: source.role.name,
          bucket: location.bucket,
          dataPrefix,
          keyArn: vault.key.arn,
          s3KmsKeyArn: vault.encryption.s3Key?.arn,
          secretKmsKeyArn: vault.encryption.secretKey?.arn,
        },
      });
      const artifact = await uploadRecoveryArtifact(ctx.target, {
        bucket: location.bucket,
        prefix: dataPrefix,
      });
      const job = parseBackupJob({
        schemaVersion: 1,
        operationId: id,
        source: {
          stackId: source.stackId,
          instanceId: source.instanceId,
          roleId: source.role.id,
          account: ctx.target.account,
          region: ctx.target.region,
        },
        settings: {
          bucket: location.bucket,
          prefix: dataPrefix,
          region: ctx.target.region,
          expectedBucketOwner: ctx.target.account,
          credentialSource: 'instance-role',
        },
        key: vault.key,
        pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${artifact.digest}`,
        namespace: 'installation',
      });
      const requestName = `native/${sourceHash(source.stackId)}/_operations/${id}/request.json`;
      const request = await store.putImmutable(requestName, job, {
        signal: AbortSignal.timeout(30000),
      });
      const captureName = `native/${sourceHash(source.stackId)}/_operations/${id}/capture.json`;
      let captured = await store.read(captureName, { signal: AbortSignal.timeout(30000) });
      if (!captured) {
        options.progress?.(
          'Quiescing the Gateway, capturing all native state, and verifying the exact remote archive...',
        );
        const result = await executeSsm(
          source.instanceId,
          ctx.target,
          [
            captureRemoteCommand(job, artifact, {
              key: `${location.prefix}/${requestName}`,
              versionId: request.versionId,
              sha256: Buffer.from(request.checksumSHA256, 'base64').toString('hex'),
            }),
          ],
          { executionSeconds: 45 * 60 },
        );
        const response = object(JSON.parse(result.stdout));
        if (
          response.ok !== true ||
          response.operationId !== id ||
          response.key !== `_operations/${id}/capture.json`
        )
          throw new Error(
            `Remote capture was not confirmed; inspect operation ${id} before retrying`,
          );
        captured = await store.read(captureName, {
          versionId: textField(response.versionId, 1024),
          signal: AbortSignal.timeout(30000),
        });
      }
      if (!captured) throw new Error('Native capture was not durably published');
      const capture = parseCapturedBackup(captured.value, job);
      const receipt: BackupReceipt = {
        schemaVersion: 1,
        kind: 'openclaw-aws-backup',
        id,
        vaultId: vault.id,
        vaultUri: vault.uri,
        completedAt: new Date().toISOString(),
        ...(options.label ? { label: options.label } : {}),
        job,
        source: { ...source, resources: [] },
        capture,
      };
      await store.putImmutable(`receipts/${id}.json`, receipt, {
        signal: AbortSignal.timeout(30000),
      });
      return receipt;
    } finally {
      store.close();
    }
  });
}

export async function verifyBackup(target: AwsTarget, uri: string, id: string) {
  // Recovery reads use the pinned key/object identities. A later change to
  // bucket defaults or lifecycle must not prevent rescuing an older valid point.
  const vault = await readRecoveryVault(target, uri);
  const receipt = await inspectBackup(target, uri, id);
  const verification = parseVerification(
    await runBackupHelper({
      target,
      operation: {
        action: 'verify',
        namespace: receipt.job.namespace,
        archive: receipt.capture.capture.location.key,
      },
      settings: {
        ...receipt.job.settings,
        credentialSource: 'default',
        readVersions: Object.fromEntries(
          Object.entries(receipt.capture.objects).map(([name, pin]) => [name, pin.versionId]),
        ),
      },
      passphrase: await recoveryPassphrase(target, vault),
    }),
  );
  if (
    verification.createdAt !== receipt.capture.verification.createdAt ||
    verification.assetCount !== receipt.capture.verification.assetCount
  )
    throw new Error('Clean-client native verification differs from the completed recovery point');
  return { id, verified: true, verification };
}

/** Native catalog discovery is authoritative; AWS receipts mark which points passed our completion barrier. */
export async function listBackups(target: AwsTarget, uri: string) {
  const vault = await readRecoveryVault(target, uri);
  const location = parseVaultUri(uri);
  const s3 = new S3Client(awsClientConfig(target));
  const ids: string[] = [];
  const signal = AbortSignal.timeout(60000);
  try {
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: location.bucket,
          ExpectedBucketOwner: target.account,
          Prefix: `${location.prefix}/receipts/`,
          ContinuationToken: token,
        }),
        { abortSignal: signal },
      );
      for (const item of page.Contents ?? []) {
        const name = item.Key?.slice(`${location.prefix}/receipts/`.length);
        if (name && /^[a-f0-9-]{36}\.json$/.test(name))
          ids.push(backupOperationId(name.slice(0, -5)));
      }
      if (ids.length > 10000)
        throw new Error('Recovery listing exceeds 10,000 points; use an explicit recovery ID');
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!token || seen.has(token)))
        throw new Error('Recovery listing pagination is incomplete');
      if (token) seen.add(token);
    } while (token);
  } finally {
    s3.destroy();
  }
  const receipts: BackupReceipt[] = [];
  const store = recoveryStore(target, vault.uri);
  try {
    for (const id of ids) receipts.push(await readPoint(store, target, vault, id));
  } finally {
    store.close();
  }
  const passphrase = receipts.length ? await recoveryPassphrase(target, vault) : '';
  const groups = new Map<string, BackupReceipt[]>();
  for (const point of receipts) {
    const group = groups.get(point.job.settings.prefix) ?? [];
    group.push(point);
    groups.set(point.job.settings.prefix, group);
  }
  for (const points of groups.values()) {
    const readVersions: Record<string, string> = {};
    for (const point of points)
      for (const [name, pin] of Object.entries(point.capture.objects)) {
        if (readVersions[name] && readVersions[name] !== pin.versionId)
          throw new Error('Native storage marker identity changed across completed points');
        readVersions[name] = pin.versionId;
      }
    const catalog = object(
      await runBackupHelper({
        target,
        operation: { action: 'list', namespace: points[0].job.namespace },
        settings: { ...points[0].job.settings, credentialSource: 'default', readVersions },
        passphrase,
      }),
    );
    const backups = catalog.backups;
    if (
      !Array.isArray(backups) ||
      points.some(
        (point) =>
          !backups.some((item: unknown) => object(item).key === point.capture.capture.location.key),
      )
    )
      throw new Error('A completed recovery point is missing from the native catalog');
  }
  return receipts.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}
