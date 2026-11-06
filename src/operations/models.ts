import { createHash, randomUUID } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../cli/utils/context.js';
import { getConfigRoot } from '../cli/utils/config.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { inspectRecoverySource, type RecoverySource } from '../aws/recovery-source.js';
import {
  deliverModelArtifact,
  hasModelArtifact,
  packagedModelArtifact,
  pinModelArtifact,
  parseModelArtifactPin,
  type ModelArtifactPin,
} from '../aws/model-artifact.js';
import { modelRemoteCommand } from '../aws/model-delivery.js';
import { executeSsm, RemoteCommandError } from '../aws/ssm.js';
import {
  nativeModelReference,
  nativeModelScope,
  type ModelScope,
} from '../openclaw/model-control.js';
import {
  modelObject,
  modelText,
  parseModelJob,
  modelJobDigest,
  nativeModelAction,
  type ModelJob,
  type ModelAction,
} from '../openclaw/model-contract.js';
import { parseModelResult, type ModelResult } from '../openclaw/model-result.js';
import { privateModelJson } from '../openclaw/model-journal.js';
import type { ModelWorkerMode } from '../openclaw/model-worker.js';
import { assertDirectoryChain } from '../openclaw/restore-layout.js';
import { withDeploymentLock } from './lock.js';
import { recordDeploymentState, loadDeploymentState } from './state.js';
import {
  inspectBedrockAccess,
  previewBedrockAccess,
  applyBedrockAccess,
  discardBedrockAccessPreview,
} from '../aws/bedrock-access.js';
import { extendBedrockSelection } from '../aws/bedrock-selection.js';
import { resolveBedrockRoute } from '../aws/bedrock-routes.js';
import { parseBedrockGrantPlan, type BedrockGrantPlan } from './bedrock-grants.js';
import { observeBedrockOnSource } from './bedrock.js';
import {
  controlFencePath,
  readControlFence,
  releaseControlFence,
  writeControlRecord as writePrivateRecord,
} from './control-fence.js';
import type { ControlFence } from './control-fence.js';

export interface ModelChangePlan {
  schemaVersion: 1;
  kind: 'model-intent';
  job: ModelJob;
  artifact: ModelArtifactPin;
  profile: RecoverySource['profile'];
  bedrock?: BedrockGrantPlan;
  before: {
    configuredPrimary: string | null;
    effectiveForNewSessions: string;
    reloadOff: boolean;
    checkedAt: string;
  };
}
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unsupported model plan fields');
};
export function parseModelChangePlan(value: unknown): ModelChangePlan {
  const row = modelObject(value);
  exact(row, ['schemaVersion', 'kind', 'job', 'artifact', 'profile', 'before', 'bedrock']);
  if (row.schemaVersion !== 1 || row.kind !== 'model-intent')
    throw new Error('Invalid model intent version');
  const job = parseModelJob(row.job);
  if (job.action.kind !== 'set') throw new Error('Model intent requires a mutation request');
  const selectedModel = job.action.model;
  const artifact = parseModelArtifactPin(row.artifact);
  const profile = modelObject(row.profile);
  exact(profile, ['arn', 'id']);
  const arn = modelText(profile.arn);
  const id = modelText(profile.id, 128);
  if (
    !arn.startsWith(
      `arn:${job.target.stackId.split(':')[1]}:iam::${job.target.account}:instance-profile/`,
    ) ||
    !/^AIPA[A-Z0-9]{12,124}$/.test(id)
  )
    throw new Error('Model intent profile differs from the hosting account');
  const before = modelObject(row.before);
  exact(before, ['configuredPrimary', 'effectiveForNewSessions', 'reloadOff', 'checkedAt']);
  const configuredPrimary =
    before.configuredPrimary === null ? null : modelText(before.configuredPrimary);
  const effectiveForNewSessions = nativeModelReference(before.effectiveForNewSessions);
  const checkedAt = modelText(before.checkedAt, 64);
  if (typeof before.reloadOff !== 'boolean' || !Number.isFinite(Date.parse(checkedAt)))
    throw new Error('Invalid model preview observation');
  const bedrock =
    row.bedrock === undefined
      ? undefined
      : parseBedrockGrantPlan(row.bedrock, job.target, { arn, id });
  if (
    bedrock &&
    (!job.bedrockRole ||
      !selectedModel.startsWith('amazon-bedrock/') ||
      !bedrock.selection.routes.some((route) => route.model === selectedModel))
  )
    throw new Error('Bedrock permission preview does not include the selected native model');
  return {
    schemaVersion: 1,
    kind: 'model-intent',
    job,
    artifact,
    profile: { arn, id },
    ...(bedrock ? { bedrock } : {}),
    before: { configuredPrimary, effectiveForNewSessions, reloadOff: before.reloadOff, checkedAt },
  };
}
function assertContext(ctx: CommandContext, job: ModelJob) {
  if (
    job.target.account !== ctx.target.account ||
    job.target.region !== ctx.target.region ||
    job.target.deploymentName !== ctx.name ||
    !job.target.stackId.includes(`:stack/${ctx.config.stack.name}/`)
  )
    throw new Error('Model operation belongs to another deployment/account/region');
}
function assertSource(source: RecoverySource, plan: ModelChangePlan) {
  if (
    source.stackId !== plan.job.target.stackId ||
    source.instanceId !== plan.job.target.instanceId ||
    source.role.id !== plan.job.target.roleId ||
    !isDeepStrictEqual(source.profile, plan.profile)
  )
    throw new Error(
      'Hosting stack, instance, role or instance profile changed after model preview',
    );
}
function jobFor(
  ctx: CommandContext,
  source: RecoverySource,
  options: { scope: ModelScope; action: ModelAction; bedrockRole?: boolean; operationId?: string },
): ModelJob {
  return parseModelJob({
    schemaVersion: 1,
    operationId: options.operationId ?? randomUUID(),
    target: {
      deploymentName: ctx.name,
      stackId: source.stackId,
      instanceId: source.instanceId,
      roleId: source.role.id,
      account: ctx.target.account,
      region: ctx.target.region,
    },
    scope: nativeModelScope(options.scope),
    action: options.action,
    bedrockRole: options.bedrockRole ?? Boolean(loadDeploymentState(ctx)?.bedrockConnection),
    runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
  });
}
export class ModelOperationError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly commandId?: string,
  ) {
    super(
      `Model operation ${operationId} did not return a confirmed outcome. Inspect it before another mutation; never replay its write.${commandId ? ` SSM command: ${commandId}.` : ''}`,
    );
    this.name = 'ModelOperationError';
  }
}
async function dispatch(
  ctx: CommandContext,
  job: ModelJob,
  artifact: ModelArtifactPin,
  mode: ModelWorkerMode,
  signal?: AbortSignal,
): Promise<ModelResult> {
  const result = await executeSsm(
    job.target.instanceId,
    ctx.target,
    [modelRemoteCommand({ job, pin: artifact, mode })],
    { executionSeconds: 960, signal },
  );
  try {
    return parseModelResult(JSON.parse(result.stdout), job, mode);
  } catch {
    throw new Error(
      'Model worker returned an unsupported/identity-mismatched result; private output was not published',
    );
  }
}
async function pinnedArtifact(ctx: CommandContext, source: RecoverySource, signal?: AbortSignal) {
  const artifact = await packagedModelArtifact();
  await deliverModelArtifact(source.instanceId, ctx.target, artifact, signal);
  return pinModelArtifact(artifact);
}
/** Shared CLI/UI read surface. These calls never refresh provider acquisition or
 * send inference. Installed tool files may be delivered on first use. */
export async function queryModels(
  ctx: CommandContext,
  options: {
    scope: ModelScope;
    action: Exclude<ModelAction, { kind: 'set' }>;
    bedrockRole?: boolean;
    signal?: AbortSignal;
  },
) {
  const scope = nativeModelScope(options.scope);
  const action = nativeModelAction(options.action);
  if (action.kind === 'set') throw new Error('Use an explicit model change preview for mutations');
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx);
    const artifact = await pinnedArtifact(ctx, source, options.signal);
    const job = jobFor(ctx, source, { ...options, scope, action });
    return dispatch(ctx, job, artifact, 'execute', options.signal);
  });
}
export async function prepareModelChange(
  ctx: CommandContext,
  options: {
    scope: ModelScope;
    model: string;
    allowRestart?: boolean;
    bedrockRole?: boolean;
    operationId?: string;
    signal?: AbortSignal;
  },
): Promise<ModelChangePlan> {
  const model = nativeModelReference(options.model);
  const scope = nativeModelScope(options.scope);
  if (options.operationId !== undefined) recordPath(options.operationId);
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx);
    const usesBedrock = model.startsWith('amazon-bedrock/');
    const read = jobFor(ctx, source, {
      ...options,
      ...(usesBedrock ? { bedrockRole: true } : {}),
      scope,
      action: { kind: 'current' },
      operationId: undefined,
    });
    const pending = await readControlFence(read.target);
    if (pending)
      throw new Error(
        `Native control operation ${pending.operationId} is pending; inspect/reconcile it before another model preview`,
      );
    const artifact = await pinnedArtifact(ctx, source, options.signal);
    const connection = usesBedrock
      ? await inspectBedrockAccess(ctx, { signal: options.signal })
      : undefined;
    if (usesBedrock && !connection)
      throw new Error(
        'Bedrock has no verified managed access policy; run providers enable-bedrock before selecting its models',
      );
    const observed = await dispatch(ctx, read, artifact, 'execute', options.signal);
    if (connection) {
      const provider = await observeBedrockOnSource(
        ctx,
        source,
        artifact,
        connection.discoveryRegion,
        options.signal,
      );
      if (provider.configHash !== observed.configHash)
        throw new Error('Native provider configuration changed during model preview');
    }
    const job = jobFor(ctx, source, {
      ...options,
      ...(usesBedrock ? { bedrockRole: true } : {}),
      scope,
      action: {
        kind: 'set',
        model,
        expectedHash: modelText(observed.configHash),
        allowRestart: options.allowRestart ?? false,
      },
    });
    if (observed.reloadOff === true && !options.allowRestart)
      throw new Error(
        'Gateway reload is off. Repeat the preview with explicit --allow-restart before approving this model change',
      );
    const basePlan = parseModelChangePlan({
      schemaVersion: 1,
      kind: 'model-intent',
      job,
      artifact,
      profile: source.profile,
      before: {
        configuredPrimary: observed.configuredPrimary,
        effectiveForNewSessions: observed.effectiveForNewSessions,
        reloadOff: observed.reloadOff,
        checkedAt: observed.checkedAt,
      },
    });
    modelRemoteCommand({ job: basePlan.job, pin: basePlan.artifact, mode: 'execute' });
    let bedrock: BedrockGrantPlan | undefined;
    if (connection) {
      const route = await resolveBedrockRoute(
        ctx.target,
        model,
        connection.discoveryRegion,
        options.signal,
      );
      const selection = extendBedrockSelection(
        connection,
        { discoveryRegion: connection.discoveryRegion, routes: [route] },
        { account: ctx.target.account, partition: job.target.stackId.split(':')[1] },
      );
      const access = await previewBedrockAccess(ctx, selection, { signal: options.signal });
      bedrock = parseBedrockGrantPlan({ selection, access }, job.target, source.profile);
    }
    const plan = bedrock ? parseModelChangePlan({ ...basePlan, bedrock }) : basePlan;
    return plan;
  });
}
function recordPath(operationId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
    throw new Error('Model operation requires a UUID');
  return path.join(getConfigRoot(), 'model-operations', operationId, 'request.json');
}
export async function loadModelChange(operationId: string) {
  const filename = recordPath(operationId);
  await assertDirectoryChain(path.dirname(filename), getConfigRoot(), false);
  return parseModelChangePlan(await privateModelJson(filename));
}
async function saveIntent(plan: ModelChangePlan) {
  const filename = recordPath(plan.job.operationId);
  await assertDirectoryChain(path.dirname(filename), getConfigRoot(), true);
  for (const directory of [path.dirname(path.dirname(filename)), path.dirname(filename)])
    if ((await lstat(directory)).mode & 0o077)
      throw new Error('Local model operation directories must be private');
  let file;
  try {
    file = await open(filename, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        'Model operation ID is already recorded. Inspect/reconcile it; the write will not be replayed',
        { cause: error },
      );
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify(plan));
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(path.dirname(filename), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
const intentOwner = (plan: ModelChangePlan): ControlFence => ({
  schemaVersion: 1,
  operationId: plan.job.operationId,
  requestDigest: plan.bedrock
    ? createHash('sha256')
        .update(modelJobDigest(plan.job))
        .update(JSON.stringify(plan.bedrock))
        .digest('hex')
    : modelJobDigest(plan.job),
  artifactDigest: plan.artifact.digest,
});
async function pendingModel(plan: ModelChangePlan) {
  return readControlFence(plan.job.target);
}
async function settleModelIntent(plan: ModelChangePlan, result: ModelResult) {
  if (
    !['complete', 'rolled-back', 'unchanged'].includes(result.phase) ||
    result.maintenanceHeld !== false
  )
    return;
  const owner = intentOwner(plan);
  await writePrivateRecord(
    path.join(path.dirname(recordPath(plan.job.operationId)), 'settled.json'),
    { ...owner, phase: result.phase },
    true,
  );
  await releaseControlFence(plan.job.target, owner);
}
function recordConfirmedSelection(ctx: CommandContext, plan: ModelChangePlan, result: ModelResult) {
  if (result.phase !== 'complete' || plan.job.action.kind !== 'set') return;
  const observation = result.reconciled === true ? modelObject(result.observed) : result;
  recordDeploymentState(
    ctx,
    { stackId: plan.job.target.stackId, stackName: ctx.config.stack.name },
    {
      modelSelection: {
        scope: plan.job.scope,
        model: plan.job.action.model,
        operationId: plan.job.operationId,
        checkedAt: modelText(observation.checkedAt, 64),
      },
    },
  );
}
/** Save immutable intent before dispatch. No automatic retry, caller-side
 * rollback or implicit update of creation/provider-secret provenance. */
export async function applyModelChange(
  ctx: CommandContext,
  input: ModelChangePlan,
  options: { signal?: AbortSignal } = {},
) {
  const plan = parseModelChangePlan(input);
  assertContext(ctx, plan.job);
  if (
    plan.job.action.kind === 'set' &&
    plan.job.action.model.startsWith('amazon-bedrock/') &&
    !plan.bedrock
  )
    throw new Error(
      'Bedrock model changes require a verified permission preview; prepare a fresh model change',
    );
  return withDeploymentLock(ctx, async () => {
    assertSource(await inspectRecoverySource(ctx), plan);
    if (
      !(await hasModelArtifact(
        plan.job.target.instanceId,
        ctx.target,
        plan.artifact,
        options.signal,
      ))
    )
      throw new Error('Pinned model worker is absent; generate a new preview before mutation');
    const pending = await pendingModel(plan);
    if (pending)
      throw new Error(
        `Model operation ID is already recorded and unresolved: ${pending.operationId}. Inspect/reconcile it before another model change on this host${pending.kind === 'bedrock-connection' ? ' using providers inspect' : ''}`,
      );
    // Reject an oversized/unsupported dispatch before claiming a local fence.
    modelRemoteCommand({ job: plan.job, pin: plan.artifact, mode: 'execute' });
    await saveIntent(plan);
    await writePrivateRecord(controlFencePath(plan.job.target), intentOwner(plan));
    try {
      if (plan.bedrock) {
        await applyBedrockAccess(ctx, plan.bedrock.selection, plan.bedrock.access, {
          signal: options.signal,
        });
        await writePrivateRecord(
          path.join(path.dirname(recordPath(plan.job.operationId)), 'iam-applied.json'),
          { ...intentOwner(plan), templateDigest: plan.bedrock.access.templateDigest },
          true,
        );
      }
      const result = await dispatch(ctx, plan.job, plan.artifact, 'execute', options.signal);
      await settleModelIntent(plan, result);
      recordConfirmedSelection(ctx, plan, result);
      return plan.bedrock
        ? {
            ...result,
            bedrockAccess: {
              stackName: plan.bedrock.access.stackName,
              templateDigest: plan.bedrock.access.templateDigest,
              invocationGrantsRetained: true,
            },
          }
        : result;
    } catch (error) {
      throw new ModelOperationError(
        plan.job.operationId,
        error instanceof RemoteCommandError ? error.commandId : undefined,
      );
    }
  });
}
/** Cancel only this model preview's unexecuted auxiliary IAM review. */
export async function cancelModelChange(ctx: CommandContext, input: ModelChangePlan) {
  const plan = parseModelChangePlan(input);
  assertContext(ctx, plan.job);
  if (!plan.bedrock) return;
  return withDeploymentLock(ctx, () => discardBedrockAccessPreview(ctx, plan.bedrock!.access));
}
export async function inspectModelOperation(
  ctx: CommandContext,
  operationId: string,
  options: { accept?: 'requested' | 'previous'; signal?: AbortSignal } = {},
) {
  const plan = await loadModelChange(operationId);
  assertContext(ctx, plan.job);
  return withDeploymentLock(ctx, async () => {
    assertSource(await inspectRecoverySource(ctx), plan);
    if (
      !(await hasModelArtifact(
        plan.job.target.instanceId,
        ctx.target,
        plan.artifact,
        options.signal,
      ))
    )
      throw new Error(
        'Original pinned model worker is absent; no replacement code or write was dispatched',
      );
    const mode =
      options.accept === undefined
        ? 'inspect'
        : options.accept === 'requested'
          ? 'accept-requested'
          : options.accept === 'previous'
            ? 'accept-previous'
            : undefined;
    if (!mode) throw new Error('Choose requested or previous model state for reconciliation');
    if (options.accept === 'requested' && plan.bedrock) {
      const current = await inspectBedrockAccess(ctx, { signal: options.signal });
      if (
        !current ||
        current.discoveryRegion !== plan.bedrock.selection.discoveryRegion ||
        !plan.bedrock.selection.routes.every((route) =>
          current.routes.some((existing) => isDeepStrictEqual(existing, route)),
        )
      )
        throw new Error(
          'Approved Bedrock model permissions are not currently verified; inspect the auxiliary IAM policy before accepting this selection',
        );
    }
    const result = await dispatch(ctx, plan.job, plan.artifact, mode, options.signal);
    await settleModelIntent(plan, result);
    if (options.accept === 'requested') recordConfirmedSelection(ctx, plan, result);
    return result;
  });
}
