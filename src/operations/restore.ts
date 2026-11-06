import { isDeepStrictEqual } from 'node:util';
import { prepareInactiveRecoveryTarget } from './recovery-target.js';
import { prepareRecoveryDelivery, executeRecoveryDelivery } from './recovery-delivery.js';
import type { AwsTarget } from '../aws/target.js';
import { resolveAwsTarget } from '../aws/target.js';
import { inspectRecoveryPresence, type RecoveryPresence } from '../aws/recovery-presence.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import type { CommandContext } from '../cli/utils/context.js';
import { configExistsByName, getConfigPathByName } from '../cli/utils/config.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { backupOperationId, inspectBackup, verifyBackup, type BackupReceipt } from './backup.js';
import { provisionRestoreTarget } from './deployment.js';
import { saveConfigByName } from '../cli/utils/config.js';
import { removeRecoveryAccessStack } from '../aws/auxiliary-stacks.js';
import { recoveryRemoteCommand } from '../aws/recovery-delivery.js';
import { executeSsm } from '../aws/ssm.js';
import { object } from '../openclaw/backup-contract.js';
import { asUbuntu, shellQuote } from '../openclaw/commands.js';
import { withDeploymentLock } from './lock.js';
import { assertDeploymentTarget, recordDeploymentState } from './state.js';
import { loadConfigByName } from '../cli/utils/config.js';
import { parseRestoreJob } from '../openclaw/restore-contract.js';
import { loadRestoreRecord, saveRestoreRecord, type RestoreRecord } from './restore-record.js';
import {
  prepareRecoveryBedrock,
  recoveryBedrockSummary,
  ensureRecoveryBedrockAccess,
} from './recovery-bedrock.js';
import {
  parseBedrockRecoveryPlan,
  type BedrockRecoveryPlan,
} from '../openclaw/bedrock-recovery-plan.js';
export type { RestoreRecord } from './restore-record.js';

export interface RestorePlan {
  schemaVersion: 1;
  operationId: string;
  point: BackupReceipt;
  context: CommandContext;
  bootstrap: RestoreBootstrap;
  sourcePresence: RecoveryPresence;
  prerequisites: string[];
  bedrock?: BedrockRecoveryPlan;
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
  const { context, bootstrap } = await prepareInactiveRecoveryTarget({
    ...options,
    kind: 'restore',
    point,
    operationId,
  });
  const sourcePresence = await inspectRecoveryPresence(options.recoveryTarget, point.job.source);
  // Full native decryption/inventory/database verification precedes any provisioning.
  await verifyBackup(options.recoveryTarget, options.vaultUri, options.pointId);
  const bedrock = await prepareRecoveryBedrock(context, point.capture.credentials.bedrock);
  return {
    schemaVersion: 1,
    operationId,
    point,
    context,
    bootstrap,
    sourcePresence,
    ...(bedrock ? { bedrock } : {}),
    prerequisites: [
      ...point.capture.credentials.prerequisites,
      ...(bedrock ? [recoveryBedrockSummary(bedrock)] : []),
      ...point.capture.omissions,
      'Gateway credentials are rotated; reconnect clients and review device/channel pairing before enabling integrations.',
      'Restoration starts with messaging, scheduled work and replay paths inactive; reactivation is a separate deliberate step.',
      ...(sourcePresence.kind !== 'gone'
        ? [
            'The source identity is still present. Use independent cloning to keep both installations, or remove the original after a verified backup before restoring its identity.',
          ]
        : []),
    ],
  };
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
  const bedrock =
    plan.bedrock === undefined
      ? undefined
      : parseBedrockRecoveryPlan(plan.bedrock, {
          account: ctx.target.account,
          partition: ctx.target.arn.split(':')[1],
        });
  if (!isDeepStrictEqual(bedrock?.intent, plan.point.capture.credentials.bedrock))
    throw new Error('Restore connection approval differs from its saved recovery point');
  const record: RestoreRecord = {
    schemaVersion: 1,
    account: ctx.target.account,
    partition: ctx.target.arn.split(':')[1],
    operationId: bootstrap.operationId,
    phase: 'provisioning',
    name: ctx.name,
    config: ctx.config,
    bootstrap,
    ...(bedrock ? { bedrock } : {}),
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
        recordDeploymentState(
          ctx,
          {
            stackName: ctx.config.stack.name,
            stackId: outputs.DeploymentId,
          },
          { restoredFrom: { operationId: record.operationId, pointId: record.recovery.pointId } },
        );
        record.phase = 'restoring';
        saveRestoreRecord(record);
        return continueRestoreOnTarget(record, ctx, recoveryTarget, plan.point, options, 'stage');
      },
    );
  } catch {
    throw new Error(
      `Restore ${bootstrap.operationId} did not complete. Gateway activation was not requested. Inspect ${ctx.config.stack.name} in ${ctx.target.region} and its private restore journal; new AWS resources may remain billable. The recovery point is retained.`,
    );
  }
}

/** Resume only a verified existing target. Missing/failed provisioning is never recreated implicitly. */
export async function resumeRestore(
  operationId: string,
  options: { activate?: boolean; progress?: (message: string) => void } = {},
): Promise<RestoreRecord> {
  const record = loadRestoreRecord(operationId);
  const target = await resolveAwsTarget(record.config.aws);
  if (
    record.account &&
    (target.account !== record.account || target.arn.split(':')[1] !== record.partition)
  )
    throw new Error('Current AWS profile differs from the pinned restore account/partition');
  const recoveryTarget = await resolveAwsTarget({
    region: record.recovery.region,
    profile: record.recovery.profile,
  });
  if (
    target.account !== recoveryTarget.account ||
    target.arn.split(':')[1] !== recoveryTarget.arn.split(':')[1]
  )
    throw new Error('Restore target and vault accounts or partitions differ');
  const ctx: CommandContext = {
    name: record.name,
    config: structuredClone(record.config),
    configPath: getConfigPathByName(record.name),
    target,
    awsEnv: {},
  };
  return withDeploymentLock(ctx, async () => {
    const point = await inspectBackup(recoveryTarget, record.recovery.uri, record.recovery.pointId);
    if ((await inspectRecoveryPresence(recoveryTarget, point.job.source)).kind !== 'gone')
      throw new Error(
        'The saved source identity is still present; use clone to keep both installations',
      );
    let status;
    try {
      status = await getStackStatus(ctx.config.stack.name, target);
    } catch (error) {
      if (!(error instanceof StackNotFoundError)) throw error;
      throw new Error(
        'Restore target stack is absent. Inspect and clean up this operation’s retained credentials before starting a new restore; no new deployment was launched',
        { cause: error },
      );
    }
    assertDeploymentTarget(ctx, status);
    if (
      !status.stackId ||
      !status.instanceId ||
      status.stackStatus !== 'CREATE_COMPLETE' ||
      (record.target &&
        (record.target.stackId !== status.stackId ||
          record.target.instanceId !== status.instanceId))
    )
      throw new Error(
        `Restore target is changing, incomplete or differs from its recorded identity (${status.stackStatus}); inspect it before retrying`,
      );
    const probe = `const fs=require('node:fs');const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));let activation=null;try{activation=read(${JSON.stringify(`/home/ubuntu/.openclaw-aws/jobs/${operationId}/activated.json`)})}catch(e){if(e.code!=='ENOENT')throw e}console.log(JSON.stringify({bootstrap:read('/home/ubuntu/.openclaw-aws/restore-bootstrap.json'),activation}));`;
    const remoteState = object(
      JSON.parse(
        (
          await executeSsm(status.instanceId, target, [asUbuntu(`node -e ${shellQuote(probe)}`)], {
            executionSeconds: 30,
          })
        ).stdout,
      ),
    );
    if (
      !isDeepStrictEqual(object(remoteState.bootstrap), {
        schemaVersion: 1,
        operationId,
        stackId: status.stackId,
        openclaw: record.bootstrap.runtime.openclaw,
        node: record.bootstrap.runtime.node,
        gateway: 'masked',
      })
    )
      throw new Error('Existing target bootstrap does not belong to this restore operation');
    if (configExistsByName(record.name)) {
      if (!isDeepStrictEqual(loadConfigByName(record.name), record.config))
        throw new Error('Local configuration changed; restore does not overwrite it');
    } else saveConfigByName(record.config, record.name, { overwrite: false });
    record.target = { stackId: status.stackId, instanceId: status.instanceId };
    if (record.phase === 'provisioning') record.phase = 'restoring';
    saveRestoreRecord(record);
    recordDeploymentState(ctx, status, {
      restoredFrom: { operationId: record.operationId, pointId: record.recovery.pointId },
    });
    if (options.activate && !record.delivery)
      throw new Error('Restore data has not been staged; resume staging before activation');
    const observedActivation =
      remoteState.activation === null || remoteState.activation === undefined
        ? undefined
        : object(remoteState.activation);
    if (
      observedActivation &&
      (observedActivation.operationId !== operationId ||
        observedActivation.stackId !== status.stackId ||
        observedActivation.instanceId !== status.instanceId ||
        observedActivation.phase !== 'active-held' ||
        observedActivation.healthy !== true)
    )
      throw new Error('Remote activation receipt differs from the selected restore');
    return continueRestoreOnTarget(
      record,
      ctx,
      recoveryTarget,
      point,
      options,
      options.activate || record.phase === 'active-held' || observedActivation
        ? 'activate'
        : 'stage',
    );
  });
}

async function continueRestoreOnTarget(
  record: RestoreRecord,
  ctx: CommandContext,
  recoveryTarget: AwsTarget,
  point: BackupReceipt,
  options: { progress?: (message: string) => void },
  mode: 'stage' | 'activate',
): Promise<RestoreRecord> {
  const bootstrap = record.bootstrap;
  record.permissionCleanupPending = true;
  saveRestoreRecord(record);
  const lease = await prepareRecoveryDelivery({
    record,
    ctx,
    recoveryTarget,
    point,
    kind: 'restore',
    buildJob: (base) =>
      parseRestoreJob({ ...base, ...(record.bedrock ? { bedrock: record.bedrock } : {}) }),
    progress: options.progress,
  });
  const { target, delivery, access } = lease;
  const { job, artifact, request } = delivery;
  record.delivery = delivery;
  saveRestoreRecord(record);
  if (!isDeepStrictEqual(job.bedrock, record.bedrock))
    throw new Error('Pinned restore Bedrock plan differs from the approved recovery intent');
  await ensureRecoveryBedrockAccess({
    ctx,
    record,
    jobTarget: job.target,
    source: target,
    save: () => saveRestoreRecord(record),
  });
  options.progress?.(
    mode === 'activate'
      ? 'Installing the native service and verifying health while integrations and restored work remain paused...'
      : 'Restoring the verified native archive, reconciling credentials and validating every member with the Gateway inactive...',
  );
  const remote = await executeRecoveryDelivery({
    instanceId: target.instanceId,
    target: ctx.target,
    operationId: bootstrap.operationId,
    activate: mode === 'activate',
    command: recoveryRemoteCommand({
      operationId: bootstrap.operationId,
      region: recoveryTarget.region,
      account: ctx.target.account,
      bucket: point.job.settings.bucket,
      pluginDirectory: job.pluginDirectory,
      worker: 'restore-worker.js',
      mode,
      artifact,
      request: {
        ...request,
      },
    }),
  });
  const result = object(JSON.parse(remote.stdout));
  if (
    result.ok !== true ||
    result.schemaVersion !== 1 ||
    result.operationId !== bootstrap.operationId ||
    result.stackId !== target.stackId ||
    result.instanceId !== target.instanceId ||
    result.phase !== (mode === 'activate' ? 'active-held' : 'ready-inactive') ||
    result.memberCount !== point.capture.members.length ||
    !Number.isSafeInteger(result.heldSessionCount) ||
    (result.heldSessionCount as number) < 0 ||
    (mode === 'stage' &&
      (!Array.isArray(result.providerParameters) ||
        result.providerParameters.some(
          (name) =>
            typeof name !== 'string' ||
            !new RegExp(`^/openclaw/${ctx.name}/providers/[a-z0-9-]+/api-key$`).test(name),
        )))
  )
    throw new Error(
      'Remote restore did not prove the selected target and required installation state',
    );
  if (mode === 'stage')
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
  else {
    if (result.healthy !== true)
      throw new Error('Activated restore did not establish native health');
    record.activation = {
      schemaVersion: 1,
      operationId: bootstrap.operationId,
      stackId: target.stackId,
      instanceId: target.instanceId,
      phase: 'active-held',
      healthy: true,
      memberCount: result.memberCount as number,
      heldSessionCount: result.heldSessionCount as number,
    };
  }
  record.phase = mode === 'activate' ? 'active-held' : 'ready-inactive';
  if (mode === 'activate' && record.bedrock)
    recordDeploymentState(
      ctx,
      { stackId: target.stackId, stackName: ctx.config.stack.name },
      {
        bedrockConnection: {
          authMode: 'instance-role',
          inferenceRegion: record.bedrock.intent.inferenceRegion,
          operationId: record.operationId,
          checkedAt: new Date().toISOString(),
        },
      },
    );
  record.permissionCleanupPending = true;
  saveRestoreRecord(record);
  options.progress?.(
    mode === 'activate'
      ? 'Removing temporary recovery/import permissions; Gateway health is verified and restored work remains held.'
      : 'Removing temporary recovery/import permissions; Gateway remains inactive.',
  );
  await removeRecoveryAccessStack(ctx.target, {
    stackName: access.stackName,
    identity: access.identity,
    roleName: access.roleName,
  });
  record.permissionCleanupPending = false;
  saveRestoreRecord(record);
  return record;
}
