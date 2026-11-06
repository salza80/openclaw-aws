import { resolveAwsTarget, type AwsTarget } from '../aws/target.js';
import type { CommandContext } from '../cli/utils/context.js';
import type { BackupReceipt } from './backup.js';
import type { Provider } from '../cli/types/index.js';
import { validateProjectName } from '../cli/utils/validation.js';
import { OPENCLAW_PROVIDER_SETUP, openClawProviderAuthArgs } from '../openclaw/install.js';
import { previewSavedClone } from './clone-preview.js';
import { prepareInactiveRecoveryTarget } from './recovery-target.js';
import { backupOperationId } from './backup.js';
import {
  explicitCloneCredentials,
  type ExplicitCloneCredentials,
} from '../openclaw/clone-credentials.js';
import { provisionInactiveTarget } from './deployment.js';
import { configExistsByName, saveConfigByName } from '../cli/utils/config.js';
import { recordDeploymentState, assertDeploymentTarget } from './state.js';
import { saveCloneRecord, loadCloneRecord, cloneReport, type CloneRecord } from './clone-record.js';
import { prepareRecoveryDelivery, executeRecoveryDelivery } from './recovery-delivery.js';
import {
  parseCloneJob,
  parseCloneWorkerResult,
  parseCloneActivationResult,
} from '../openclaw/clone-contract.js';
import { createSsmClient } from '../cli/utils/aws-clients.js';
import { importRestoreProviderSecrets } from '../openclaw/restore-secrets.js';
import { recoveryRemoteCommand, installedRecoveryRemoteCommand } from '../aws/recovery-delivery.js';
import { removeRecoveryAccessStack } from '../aws/auxiliary-stacks.js';
import { object } from '../openclaw/backup-contract.js';
import { withDeploymentLock } from './lock.js';
import { getConfigPathByName, loadConfigByName } from '../cli/utils/config.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { StackNotFoundError } from '../cli/utils/errors.js';
import { inspectRecoverySource, removeSourceRecoveryAccess } from '../aws/recovery-source.js';
import { probeRecoveryBootstrap } from '../aws/recovery-probe.js';
import { inspectBackup } from './backup.js';
import { isDeepStrictEqual } from 'node:util';
import { cleanupInactiveRecovery } from './restore-cleanup.js';

/** Whole-team knowledge clone intake. Source infrastructure may still be live;
 * source identity is not adopted, so no takeover/destruction check is required.
 */
export async function prepareClone(options: {
  recoveryTarget: AwsTarget;
  vaultUri: string;
  pointId: string;
  name: string;
  apiProvider: Provider;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  volumeGiB?: number;
  operationId?: string;
  signal?: AbortSignal;
}) {
  const name = validateProjectName(options.name);
  if (name !== true) throw new Error(String(name));
  if (!Object.hasOwn(OPENCLAW_PROVIDER_SETUP, options.apiProvider))
    throw new Error('Unsupported clone model provider');
  openClawProviderAuthArgs(options);
  const operationId = backupOperationId(options.operationId);
  options.signal?.throwIfAborted();
  const { point, preview } = await previewSavedClone(options);
  if (
    preview.providersInUse.includes('cloudflare-ai-gateway') &&
    options.apiProvider !== 'cloudflare-ai-gateway-api-key'
  )
    throw new Error(
      'This source uses Cloudflare AI Gateway. Select it as the primary clone provider with explicit target account/gateway IDs, and supply any other provider credentials separately',
    );
  let additionalStagingBytes = 0;
  const scopes = [
    ...preview.content.members,
    ...preview.content.members.flatMap((member) =>
      member.workshopSkills ? [member.workshopSkills] : [],
    ),
    ...(preview.content.sharedSkills ? [preview.content.sharedSkills] : []),
  ];
  for (const scope of scopes)
    for (const file of scope.files) {
      additionalStagingBytes += file.bytes;
      if (!Number.isSafeInteger(additionalStagingBytes) || file.bytes < 0)
        throw new Error('Clone workspace size exceeds its supported staging bound');
    }
  const plan = await prepareInactiveRecoveryTarget({
    ...options,
    point,
    operationId,
    kind: 'clone',
    additionalStagingBytes,
    openclaw: {
      apiProvider: options.apiProvider,
      ...(options.apiProvider === 'cloudflare-ai-gateway-api-key'
        ? {
            cloudflare: {
              accountId: options.cloudflareAccountId!,
              gatewayId: options.cloudflareGatewayId!,
            },
          }
        : {}),
    },
  });
  options.signal?.throwIfAborted();
  return { ...plan, schemaVersion: 1 as const, preview };
}
export type ClonePlan = Awaited<ReturnType<typeof prepareClone>>;

/** Continue only this existing owned target. Fresh onboarding is never replayed
 * over a partial native installation, and an absent target is not reprovisioned.
 */
export async function resumeClone(
  operationId: string,
  options: {
    activate?: boolean;
    credentials?: ExplicitCloneCredentials;
    progress?: (message: string) => void;
  } = {},
): Promise<CloneRecord> {
  const record = loadCloneRecord(operationId);
  if (options.credentials && record.result)
    throw new Error(
      'Clone credentials are already certified; use provider management after activation instead of changing an in-progress recovery request',
    );
  const target = await resolveAwsTarget(record.config.aws);
  const ctx: CommandContext = {
    name: record.name,
    config: structuredClone(record.config),
    configPath: getConfigPathByName(record.name),
    target,
    awsEnv: {},
  };
  if (target.account !== record.account || target.arn.split(':')[1] !== record.partition)
    throw new Error('Current AWS profile differs from the pinned clone account/partition');
  let environment: Record<string, string> | undefined;
  if (options.credentials) {
    const supplied = explicitCloneCredentials(record.credentials.primary, options.credentials);
    if (JSON.stringify(supplied.providers) !== JSON.stringify(record.credentials.providers))
      throw new Error('Resume cannot change the pinned clone provider selection');
    environment = supplied.environment;
  }
  return withDeploymentLock(ctx, async () => {
    let status;
    try {
      status = await getStackStatus(ctx.config.stack.name, target);
    } catch (error) {
      if (!(error instanceof StackNotFoundError)) throw error;
      throw new Error(
        'Clone target is absent; inspect/cleanup the retained operation before starting a new clone. No new deployment was launched',
        { cause: error },
      );
    }
    assertDeploymentTarget(ctx, status);
    if (
      !status.stackId ||
      !status.instanceId ||
      status.stackStatus !== 'CREATE_COMPLETE' ||
      status.stackId.split(':')[4] !== target.account ||
      (record.target &&
        (record.target.stackId !== status.stackId ||
          record.target.instanceId !== status.instanceId))
    )
      throw new Error('Clone target is incomplete, changing or differs from this operation');
    const bootstrap = await probeRecoveryBootstrap(
      target,
      status.instanceId,
      status.stackId,
      record.bootstrap,
    );
    if (configExistsByName(record.name)) {
      if (!isDeepStrictEqual(loadConfigByName(record.name), record.config))
        throw new Error('Local clone configuration changed; nothing was overwritten');
    } else saveConfigByName(record.config, record.name, { overwrite: false });
    record.target = { stackId: status.stackId, instanceId: status.instanceId };
    recordDeploymentState(ctx, status, {
      clonedFrom: { operationId, pointId: record.recovery.pointId },
    });
    if (!record.result) {
      if (!bootstrap.masked || !bootstrap.inactive)
        throw new Error(
          'Uncertified clone is not confirmed masked/inactive; source access was not reattached',
        );
      const recoveryTarget = await resolveAwsTarget({
        region: record.recovery.region,
        profile: record.recovery.profile,
      });
      if (
        recoveryTarget.account !== target.account ||
        recoveryTarget.arn.split(':')[1] !== target.arn.split(':')[1]
      )
        throw new Error('Clone target and recovery vault accounts or partitions differ');
      const point = await inspectBackup(
        recoveryTarget,
        record.recovery.uri,
        record.recovery.pointId,
      );
      record.phase = 'cloning';
      saveCloneRecord(record);
      await continueCloneStage(record, ctx, recoveryTarget, point, options, environment);
      if (!options.activate) return record;
    }
    const live = await inspectRecoverySource(ctx);
    const delivery = record.delivery;
    if (
      !delivery ||
      live.stackId !== record.target.stackId ||
      live.instanceId !== record.target.instanceId ||
      live.role.id !== delivery.job.target.roleId ||
      target.account !== delivery.job.target.account
    )
      throw new Error('Pinned clone delivery does not belong to this live target');
    // Do not reattach source archive/key access just to activate installed code.
    await removeSourceRecoveryAccess(target, live.stackId);
    record.permissionCleanupPending = false;
    saveCloneRecord(record);
    const activate =
      options.activate || record.phase === 'active' || !bootstrap.masked || !bootstrap.inactive;
    options.progress?.(
      activate
        ? 'Verifying revoked source access and activating the fresh Gateway with integrations disconnected...'
        : 'Revalidating the already staged native clone...',
    );
    const remote = await executeRecoveryDelivery({
      instanceId: live.instanceId,
      target,
      operationId,
      activate: Boolean(activate),
      command: installedRecoveryRemoteCommand({
        operationId,
        pluginDirectory: delivery.job.pluginDirectory,
        artifact: delivery.artifact,
        requestSha256: delivery.request.sha256,
        mode: activate ? 'activate-clone' : 'clone',
      }),
    });
    const output = object(JSON.parse(remote.stdout));
    if (output.ok !== true)
      throw new Error('Clone completion was not confirmed; inspect the target before retrying');
    if (activate) {
      record.activation = parseCloneActivationResult(output, delivery.job);
      if (record.activation.configurationHash !== record.result!.configurationHash)
        throw new Error('Clone activation configuration differs from staging');
      record.phase = 'active';
    } else {
      record.result = parseCloneWorkerResult(output, delivery.job);
      record.phase = 'ready-inactive';
    }
    saveCloneRecord(record);
    return record;
  });
}
export async function cleanupClone(operationId: string): Promise<void> {
  await cleanupInactiveRecovery(loadCloneRecord(operationId));
}

/** Create a fresh inactive target, then install only the reviewed knowledge.
 * Credential values are separate from the persistable plan, record and delivery.
 */
export async function stageClone(
  plan: ClonePlan,
  recoveryTarget: AwsTarget,
  values: ExplicitCloneCredentials,
  options: { progress?: (message: string) => void } = {},
): Promise<CloneRecord> {
  const ctx = { ...plan.context, config: structuredClone(plan.context.config) };
  const primary = ctx.config.openclaw?.apiProvider;
  if (
    !primary ||
    plan.operationId !== plan.bootstrap.operationId ||
    ctx.target.account !== recoveryTarget.account ||
    recoveryTarget.region !== plan.point.job.source.region
  )
    throw new Error('Clone plan and selected AWS target are inconsistent');
  const selected = explicitCloneCredentials(primary, values);
  const available = new Set(
    selected.providers.flatMap((provider) => [
      OPENCLAW_PROVIDER_SETUP[provider].providerId,
      ...(OPENCLAW_PROVIDER_SETUP[provider].providerAliases ?? []),
    ]),
  );
  const missing = plan.preview.providersInUse.filter((provider) => !available.has(provider));
  if (missing.length)
    throw new Error(`Clone requires explicit compatible credentials for: ${missing.join(', ')}`);
  if (configExistsByName(ctx.name))
    throw new Error('Clone target configuration name is already in use');
  const record: CloneRecord = {
    schemaVersion: 1,
    kind: 'clone',
    account: ctx.target.account,
    partition: ctx.target.arn.split(':')[1],
    operationId: plan.operationId,
    phase: 'provisioning',
    name: ctx.name,
    config: ctx.config,
    bootstrap: plan.bootstrap,
    recovery: {
      uri: plan.point.vaultUri,
      region: recoveryTarget.region,
      ...(recoveryTarget.profile ? { profile: recoveryTarget.profile } : {}),
      pointId: plan.point.id,
    },
    preview: {
      contentDigest: plan.preview.content.digest,
      policyDigest: plan.preview.policyDigest,
    },
    report: cloneReport(plan.preview),
    credentials: {
      primary,
      providers: selected.providers,
      ...(ctx.config.openclaw?.cloudflare ? { cloudflare: ctx.config.openclaw.cloudflare } : {}),
    },
  };
  saveCloneRecord(record, true);
  try {
    return await provisionInactiveTarget(
      ctx,
      {
        restore: plan.bootstrap,
        clonedFrom: { pointId: plan.point.id },
        progress: options.progress,
      },
      async (outputs) => {
        saveConfigByName(ctx.config, ctx.name, { overwrite: false });
        record.target = { stackId: outputs.DeploymentId, instanceId: outputs.InstanceId };
        record.phase = 'cloning';
        saveCloneRecord(record);
        recordDeploymentState(
          ctx,
          {
            stackName: ctx.config.stack.name,
            stackStatus: 'CREATE_COMPLETE',
            stackId: outputs.DeploymentId,
          },
          { clonedFrom: { operationId: record.operationId, pointId: plan.point.id } },
        );
        return continueCloneStage(
          record,
          ctx,
          recoveryTarget,
          plan.point,
          options,
          selected.environment,
        );
      },
    );
  } catch {
    throw new Error(
      `Clone ${record.operationId} did not complete. Gateway activation was not requested. Inspect ${ctx.config.stack.name} in ${ctx.target.region}; owned resources may remain billable. Use clone inspect/cleanup before retrying an incomplete native setup. The source and selected backup are unchanged.`,
    );
  }
}

async function continueCloneStage(
  record: CloneRecord,
  ctx: CommandContext,
  recoveryTarget: AwsTarget,
  point: BackupReceipt,
  options: { progress?: (message: string) => void },
  environment?: Record<string, string>,
): Promise<CloneRecord> {
  const lease = await prepareRecoveryDelivery({
    record,
    ctx,
    recoveryTarget,
    point: point,
    kind: 'clone',
    progress: options.progress,
    buildJob: (base) =>
      parseCloneJob({
        ...base,
        kind: 'clone',
        preview: record.preview,
        credentials: record.credentials,
      }),
  });
  record.delivery = lease.delivery;
  record.permissionCleanupPending = true;
  saveCloneRecord(record);
  if (environment) {
    const ssm = createSsmClient(ctx.target);
    try {
      await importRestoreProviderSecrets(
        ssm,
        {
          deploymentName: ctx.name,
          deploymentId: lease.target.stackId,
          operationId: record.operationId,
        },
        environment,
      );
    } finally {
      ssm.destroy();
    }
  }
  options.progress?.(
    'Creating fresh native identities and copying reviewed knowledge; source credentials and automatic integrations are excluded...',
  );
  const remote = await executeRecoveryDelivery({
    instanceId: lease.target.instanceId,
    target: ctx.target,
    operationId: record.operationId,
    activate: false,
    command: recoveryRemoteCommand({
      operationId: record.operationId,
      region: recoveryTarget.region,
      account: ctx.target.account,
      bucket: point.job.settings.bucket,
      pluginDirectory: lease.delivery.job.pluginDirectory,
      worker: 'restore-worker.js',
      mode: 'clone',
      artifact: lease.delivery.artifact,
      request: lease.delivery.request,
    }),
  });
  const output = object(JSON.parse(remote.stdout));
  if (output.ok !== true) throw new Error('Remote clone did not prove readiness');
  record.result = parseCloneWorkerResult(output, lease.delivery.job);
  if (record.result.fileCount !== record.report.copiedFiles)
    throw new Error('Clone file count differs from the reviewed preview');
  record.phase = 'ready-inactive';
  saveCloneRecord(record);
  options.progress?.('Removing temporary source-backup/key access before any activation...');
  await removeRecoveryAccessStack(ctx.target, lease.access);
  record.permissionCleanupPending = false;
  saveCloneRecord(record);
  return record;
}
