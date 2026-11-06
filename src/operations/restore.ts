import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AwsTarget } from '../aws/target.js';
import { resolveAwsTarget } from '../aws/target.js';
import { inspectRecoveryPresence, type RecoveryPresence } from '../aws/recovery-presence.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { OpenClawConfig } from '../cli/types/index.js';
import { configExistsByName, getConfigPathByName, getConfigRoot } from '../cli/utils/config.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { validateProjectName } from '../cli/utils/validation.js';
import { validateAWSRegion, validateInstanceCapabilities } from '../cli/utils/aws-validation.js';
import { assertRestoreSecretNamespace } from './deployment.js';
import { backupOperationId, inspectBackup, verifyBackup, type BackupReceipt } from './backup.js';
import { provisionRestoreTarget } from './deployment.js';
import { saveConfigByName } from '../cli/utils/config.js';
import { readRecoveryVault } from './vault.js';
import { inspectRecoverySource, sourceHash, sourceAccessIdentity } from '../aws/recovery-source.js';
import { ensureRecoveryStack, removeRecoveryAccessStack } from '../aws/auxiliary-stacks.js';
import { uploadRecoveryArtifact } from '../aws/recovery-artifact.js';
import { recoveryRemoteCommand } from '../aws/recovery-delivery.js';
import { recoveryStore } from '../aws/recovery-store.js';
import { executeSsm } from '../aws/ssm.js';
import { object } from '../openclaw/backup-contract.js';
import { parseRestoreJob } from '../openclaw/restore-contract.js';
import type { RestoreWorkerResult } from '../openclaw/restore-worker.js';

export interface RestorePlan {
  schemaVersion: 1;
  operationId: string;
  point: BackupReceipt;
  context: CommandContext;
  bootstrap: RestoreBootstrap;
  sourcePresence: RecoveryPresence;
  prerequisites: string[];
}

/** Read-only intake for CLI and dashboard. No source config, source disk or old SSM key.
 * An inspected plan is not authority to restore while a source is still live.
 */
export async function prepareRestore(options: {
  recoveryTarget: AwsTarget;
  vaultUri: string;
  pointId: string;
  name?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  volumeGiB?: number;
  operationId?: string;
}): Promise<RestorePlan> {
  const operationId = backupOperationId(options.operationId);
  const point = await inspectBackup(options.recoveryTarget, options.vaultUri, options.pointId);
  const name = options.name ?? point.source.stackName.replace(/^OpenclawStack-/, '');
  const validation = validateProjectName(name);
  if (validation !== true) throw new Error(String(validation));
  if (
    configExistsByName(name) ||
    ['deployments', 'outputs'].some((directory) =>
      fs.existsSync(path.join(getConfigRoot(), directory, `${name}.json`)),
    )
  )
    throw new Error(
      'Restore target has local configuration or deployment metadata; select an unused name or explicitly resolve the retained deployment',
    );
  const minimum = Math.max(
    30,
    point.source.instance.minimumDiskGiB,
    Math.ceil(point.capture.capture.location.plaintextBytes / 1024 ** 3) + 8,
  );
  const bootstrap = parseRestoreBootstrap({
    operationId,
    runtime: point.capture.runtime,
    volumeGiB: options.volumeGiB ?? minimum,
  });
  if (bootstrap.volumeGiB < minimum)
    throw new Error(
      `Restore volume must be at least ${minimum} GiB for the saved disk and staged data`,
    );
  const target = await resolveAwsTarget({
    region: options.region ?? point.job.source.region,
    profile: options.profile ?? options.recoveryTarget.profile,
  });
  if (
    target.account !== options.recoveryTarget.account ||
    target.arn.split(':')[1] !== options.recoveryTarget.arn.split(':')[1]
  )
    throw new Error(
      'Restore requires the recovery vault and target in the same AWS account and partition',
    );
  const config: OpenClawConfig = {
    version: '1.0',
    aws: { region: target.region, ...(target.profile ? { profile: target.profile } : {}) },
    network: { useDefaultVpc: true },
    instance: {
      type: options.instanceType ?? point.source.instance.type,
      name: `openclaw-${name}`,
    },
    features: { cloudWatchLogs: false },
    stack: { name: `OpenclawStack-${name}` },
  };
  const context: CommandContext = {
    name,
    config,
    configPath: getConfigPathByName(name),
    target,
    awsEnv: {},
  };
  try {
    await getStackStatus(config.stack.name, target);
    throw new Error(
      'Restore target stack already exists; restore never replaces a live deployment',
    );
  } catch (error) {
    if (!(error instanceof StackNotFoundError)) throw error;
  }
  await assertRestoreSecretNamespace(context);
  await validateAWSRegion(target);
  await validateInstanceCapabilities(config.instance.type, target);
  const sourcePresence = await inspectRecoveryPresence(options.recoveryTarget, point.job.source);
  // Full native decryption/inventory/database verification precedes any provisioning.
  await verifyBackup(options.recoveryTarget, options.vaultUri, options.pointId);
  return {
    schemaVersion: 1,
    operationId,
    point,
    context,
    bootstrap,
    sourcePresence,
    prerequisites: [
      ...point.capture.credentials.prerequisites,
      ...point.capture.omissions,
      'Gateway credentials are rotated; reconnect clients and review device/channel pairing before enabling integrations.',
      'Restoration starts with messaging, scheduled work and replay paths inactive; reactivation is a separate deliberate step.',
      ...(sourcePresence.kind !== 'gone'
        ? [
            'The source identity is still present. Terminate it or complete a separately verified persistent takeover before activation.',
          ]
        : []),
    ],
  };
}

export interface RestoreRecord {
  schemaVersion: 1;
  operationId: string;
  phase: 'provisioning' | 'restoring' | 'ready-inactive';
  name: string;
  config: OpenClawConfig;
  bootstrap: RestoreBootstrap;
  recovery: { uri: string; region: string; profile?: string; pointId: string };
  target?: { stackId: string; instanceId: string };
  result?: RestoreWorkerResult;
}
function saveRestoreRecord(record: RestoreRecord, create = false) {
  const directory = path.join(getConfigRoot(), 'restores');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${backupOperationId(record.operationId)}.json`);
  const body = JSON.stringify(record, null, 2);
  if (create) fs.writeFileSync(filename, body, { flag: 'wx', mode: 0o600 });
  else {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/** Provision and adopt native data. Deliberate service activation is a separate operation. */
export async function stageRestore(
  plan: RestorePlan,
  recoveryTarget: AwsTarget,
  options: { progress?: (message: string) => void } = {},
): Promise<RestoreRecord> {
  const ctx = { ...plan.context, config: structuredClone(plan.context.config) };
  const bootstrap = parseRestoreBootstrap(plan.bootstrap);
  if (
    bootstrap.operationId !== plan.operationId ||
    recoveryTarget.account !== ctx.target.account ||
    recoveryTarget.region !== plan.point.job.source.region
  )
    throw new Error('Restore plan and recovery AWS target are inconsistent');
  const presence = await inspectRecoveryPresence(recoveryTarget, plan.point.job.source);
  if (presence.kind !== 'gone')
    throw new Error(
      'Source identity is still present. Use the independent clone workflow to keep both claws, or remove the source after a verified backup before restoring its identity.',
    );
  if (configExistsByName(ctx.name)) throw new Error('Restore configuration name is already in use');
  const record: RestoreRecord = {
    schemaVersion: 1,
    operationId: bootstrap.operationId,
    phase: 'provisioning',
    name: ctx.name,
    config: ctx.config,
    bootstrap,
    recovery: {
      uri: plan.point.vaultUri,
      region: recoveryTarget.region,
      ...(recoveryTarget.profile ? { profile: recoveryTarget.profile } : {}),
      pointId: plan.point.id,
    },
  };
  saveRestoreRecord(record, true);
  try {
    return await provisionRestoreTarget(
      ctx,
      { restore: bootstrap, progress: options.progress },
      async (outputs) => {
        // Save only this newly validated identity; never overwrite another local claw.
        saveConfigByName(ctx.config, ctx.name, { overwrite: false });
        record.target = { stackId: outputs.DeploymentId, instanceId: outputs.InstanceId };
        record.phase = 'restoring';
        saveRestoreRecord(record);
        const target = await inspectRecoverySource(ctx);
        if (
          target.stackId !== record.target.stackId ||
          target.instanceId !== record.target.instanceId
        )
          throw new Error('New restore target identity changed');
        const vault = await readRecoveryVault(recoveryTarget, record.recovery.uri);
        if (vault.id !== plan.point.vaultId)
          throw new Error('Recovery vault identity changed since planning');
        const access = {
          kind: 'recovery-access' as const,
          stackName: `OpenclawRecovery-${sourceHash(target.stackId)}-restore-${bootstrap.operationId}`,
          identity: sourceAccessIdentity(target.stackId, target.role.id),
          access: {
            roleName: target.role.name,
            bucket: plan.point.job.settings.bucket,
            dataPrefix: plan.point.job.settings.prefix,
            keyArn: vault.key.arn,
            s3KmsKeyArn: vault.encryption.s3Key?.arn,
            secretKmsKeyArn: vault.encryption.secretKey?.arn,
            mode: 'read' as const,
            recoveryRegion: recoveryTarget.region,
            secretImport: {
              deploymentName: ctx.name,
              deploymentId: target.stackId,
              operationId: bootstrap.operationId,
            },
          },
        };
        options.progress?.(
          'Attaching temporary read-only recovery access and create-only target secret import...',
        );
        await ensureRecoveryStack(ctx.target, access);
        const location = {
          bucket: plan.point.job.settings.bucket,
          prefix: plan.point.job.settings.prefix,
        };
        const artifact = await uploadRecoveryArtifact(recoveryTarget, location);
        const job = parseRestoreJob({
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
          backup: { job: plan.point.job, capture: plan.point.capture },
          pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${artifact.digest}`,
        });
        const store = recoveryStore(recoveryTarget, `s3://${location.bucket}/${location.prefix}`);
        try {
          const requestName = `_operations/restore/${bootstrap.operationId}/request.json`;
          const request = await store.putImmutable(requestName, job, {
            signal: AbortSignal.timeout(30000),
          });
          options.progress?.(
            'Restoring the verified native archive, reconciling credentials and validating every member with the Gateway inactive...',
          );
          const remote = await executeSsm(
            target.instanceId,
            ctx.target,
            [
              recoveryRemoteCommand({
                operationId: bootstrap.operationId,
                region: recoveryTarget.region,
                account: ctx.target.account,
                bucket: location.bucket,
                pluginDirectory: job.pluginDirectory,
                worker: 'restore-worker.js',
                artifact,
                request: {
                  key: `${location.prefix}/${requestName}`,
                  versionId: request.versionId,
                  sha256: Buffer.from(request.checksumSHA256, 'base64').toString('hex'),
                },
              }),
            ],
            { executionSeconds: 45 * 60 },
          );
          const result = object(JSON.parse(remote.stdout));
          if (
            result.ok !== true ||
            result.schemaVersion !== 1 ||
            result.operationId !== bootstrap.operationId ||
            result.stackId !== target.stackId ||
            result.instanceId !== target.instanceId ||
            result.phase !== 'ready-inactive' ||
            result.memberCount !== plan.point.capture.members.length ||
            !Number.isSafeInteger(result.heldSessionCount) ||
            (result.heldSessionCount as number) < 0 ||
            !Array.isArray(result.providerParameters) ||
            result.providerParameters.some(
              (name) =>
                typeof name !== 'string' ||
                !new RegExp(`^/openclaw/${ctx.name}/providers/[a-z0-9-]+/api-key$`).test(name),
            )
          )
            throw new Error(
              'Remote restore did not prove the selected target and complete inactive installation',
            );
          record.result = {
            schemaVersion: 1,
            operationId: bootstrap.operationId,
            stackId: target.stackId,
            instanceId: target.instanceId,
            phase: 'ready-inactive',
            memberCount: result.memberCount as number,
            heldSessionCount: result.heldSessionCount as number,
            providerParameters: result.providerParameters as string[],
          };
        } finally {
          store.close();
        }
        options.progress?.(
          'Removing temporary recovery/import permissions; Gateway remains inactive.',
        );
        await removeRecoveryAccessStack(ctx.target, {
          stackName: access.stackName,
          identity: access.identity,
          roleName: target.role.name,
        });
        record.phase = 'ready-inactive';
        saveRestoreRecord(record);
        return record;
      },
    );
  } catch {
    throw new Error(
      `Restore ${bootstrap.operationId} did not complete. Gateway activation was not requested. Inspect ${ctx.config.stack.name} in ${ctx.target.region} and its private restore journal; new AWS resources may remain billable. The recovery point is retained.`,
    );
  }
}
