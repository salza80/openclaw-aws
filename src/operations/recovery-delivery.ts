import { isDeepStrictEqual } from 'node:util';
import type { AwsTarget } from '../aws/target.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { RestoreJob } from '../openclaw/restore-contract.js';
import type { BackupReceipt } from './backup.js';
import type { RecoveryRecordBase, RecoveryDelivery } from './recovery-record.js';
import { inspectRecoverySource, sourceHash, sourceAccessIdentity } from '../aws/recovery-source.js';
import { readRecoveryVault } from './vault.js';
import { ensureRecoveryStack } from '../aws/auxiliary-stacks.js';
import { uploadRecoveryArtifact } from '../aws/recovery-artifact.js';
import { recoveryStore } from '../aws/recovery-store.js';

/** Shared read-only archive access and immutable delivery setup. Caller persists
 * the returned pins before executing code, then removes this temporary lease.
 */
export async function prepareRecoveryDelivery<T extends RestoreJob>(options: {
  record: RecoveryRecordBase & { delivery?: RecoveryDelivery<T> };
  ctx: CommandContext;
  recoveryTarget: AwsTarget;
  point: BackupReceipt;
  kind: 'restore' | 'clone';
  buildJob: (base: RestoreJob) => T;
  progress?: (message: string) => void;
}) {
  const { record, ctx, recoveryTarget, point, kind, buildJob } = options;
  const bootstrap = record.bootstrap;
  const target = await inspectRecoverySource(ctx);
  if (
    !record.target ||
    target.stackId !== record.target.stackId ||
    target.instanceId !== record.target.instanceId
  )
    throw new Error('New recovery target identity changed');
  if (
    record.delivery &&
    (record.delivery.job.target.stackId !== target.stackId ||
      record.delivery.job.target.instanceId !== target.instanceId ||
      record.delivery.job.target.roleId !== target.role.id ||
      !isDeepStrictEqual(record.delivery.job.backup, { job: point.job, capture: point.capture }))
  )
    throw new Error(
      'Pinned recovery delivery no longer matches its target or selected recovery point',
    );
  const vault = await readRecoveryVault(recoveryTarget, point.vaultUri);
  if (vault.id !== point.vaultId) throw new Error('Recovery vault identity changed since planning');
  const access = {
    kind: 'recovery-access' as const,
    stackName: `OpenclawRecovery-${sourceHash(target.stackId)}-${kind}-${bootstrap.operationId}`,
    identity: sourceAccessIdentity(target.stackId, target.role.id),
    access: {
      roleName: target.role.name,
      bucket: point.job.settings.bucket,
      dataPrefix: point.job.settings.prefix,
      keyArn: vault.key.arn,
      s3KmsKeyArn: vault.encryption.s3Key?.arn,
      secretKmsKeyArn: vault.encryption.secretKey?.arn,
      mode: 'read' as const,
      recoveryRegion: recoveryTarget.region,
      secretImport: {
        ...(kind === 'clone' ? { readOnly: true as const } : {}),
        deploymentName: ctx.name,
        deploymentId: target.stackId,
        operationId: bootstrap.operationId,
      },
    },
  };
  options.progress?.(
    kind === 'clone'
      ? 'Attaching temporary source-backup read access and target credential tag checks...'
      : 'Attaching temporary read-only recovery access and create-only target secret import...',
  );
  await ensureRecoveryStack(ctx.target, access);
  const location = {
    bucket: point.job.settings.bucket,
    prefix: point.job.settings.prefix,
  };
  const artifact =
    record.delivery?.artifact ?? (await uploadRecoveryArtifact(recoveryTarget, location));
  const job =
    record.delivery?.job ??
    buildJob({
      schemaVersion: 1,
      bootstrap,
      target: {
        deploymentName: ctx.name,
        stackId: target.stackId,
        instanceId: target.instanceId,
        roleId: target.role.id,
        account: ctx.target.account,
        region: ctx.target.region,
      },
      backup: { job: point.job, capture: point.capture },
      pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${artifact.digest}`,
    });
  const store = recoveryStore(recoveryTarget, `s3://${location.bucket}/${location.prefix}`);
  try {
    const requestName = `_operations/${kind}/${bootstrap.operationId}/request.json`;
    const request = record.delivery
      ? {
          versionId: record.delivery.request.versionId,
          checksumSHA256: Buffer.from(record.delivery.request.sha256, 'hex').toString('base64'),
        }
      : await store.putImmutable(requestName, job, {
          signal: AbortSignal.timeout(30000),
        });
    const delivery = {
      job,
      artifact,
      request: {
        key: `${location.prefix}/${requestName}`,
        versionId: request.versionId,
        sha256: Buffer.from(request.checksumSHA256, 'base64').toString('hex'),
      },
    };
    return {
      target,
      delivery,
      access: {
        stackName: access.stackName,
        identity: access.identity,
        roleName: target.role.name,
      },
    };
  } finally {
    store.close();
  }
}
