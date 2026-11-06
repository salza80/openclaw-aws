import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../cli/utils/context.js';
import { getConfigRoot } from '../cli/utils/config.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { inspectRecoverySource, type RecoverySource } from '../aws/recovery-source.js';
import { resolveBedrockRoute } from '../aws/bedrock-routes.js';
import type { BedrockAccessSelection } from '../aws/bedrock-selection.js';
import {
  planBedrockAccessExtension,
  previewBedrockAccess,
  applyBedrockAccess,
  discardBedrockAccessPreview,
  inspectBedrockAccess,
  type BedrockAccessPreview,
} from '../aws/bedrock-access.js';
import {
  deliverModelArtifact,
  packagedModelArtifact,
  pinModelArtifact,
  parseModelArtifactPin,
  hasModelArtifact,
  type ModelArtifactPin,
} from '../aws/model-artifact.js';
import { bedrockRemoteCommand } from '../aws/model-delivery.js';
import { executeSsm, RemoteCommandError } from '../aws/ssm.js';
import {
  parseBedrockJob,
  bedrockJobDigest,
  type BedrockJob,
  type BedrockWorkerMode,
} from '../openclaw/bedrock-contract.js';
import { BEDROCK_PLUGIN } from '../openclaw/bedrock-configuration.js';
import { parseBedrockResult, type BedrockResult } from '../openclaw/bedrock-result.js';
import { modelObject, modelText } from '../openclaw/model-contract.js';
import { privateModelJson } from '../openclaw/model-journal.js';
import { assertDirectoryChain } from '../openclaw/restore-layout.js';
import { withDeploymentLock } from './lock.js';
import { recordDeploymentState } from './state.js';
import { parseBedrockGrantPlan } from './bedrock-grants.js';
import {
  controlFencePath,
  readControlFence,
  releaseControlFence,
  writeControlRecord,
  type ControlFence,
} from './control-fence.js';

export interface BedrockConnectionPlan {
  schemaVersion: 1;
  kind: 'bedrock-intent';
  job: BedrockJob;
  artifact: ModelArtifactPin;
  profile: RecoverySource['profile'];
  selection: BedrockAccessSelection;
  access: BedrockAccessPreview;
}
function context(ctx: CommandContext, job: BedrockJob) {
  if (
    ctx.name !== job.target.deploymentName ||
    ctx.target.account !== job.target.account ||
    ctx.target.region !== job.target.region ||
    !job.target.stackId.includes(`:stack/${ctx.config.stack.name}/`)
  )
    throw new Error('Bedrock operation belongs to another deployment/account/region');
}
function sourceIdentity(source: RecoverySource) {
  return {
    stackId: source.stackId,
    instanceId: source.instanceId,
    role: source.role,
    profile: source.profile,
  };
}
function assertSource(source: RecoverySource, plan: BedrockConnectionPlan) {
  if (
    source.stackId !== plan.job.target.stackId ||
    source.instanceId !== plan.job.target.instanceId ||
    source.role.id !== plan.job.target.roleId ||
    !isDeepStrictEqual(source.profile, plan.profile) ||
    !isDeepStrictEqual(sourceIdentity(source), plan.access.source)
  )
    throw new Error('Bedrock hosting stack, instance, role or profile changed after preview');
}
function uuid(input: unknown) {
  const value = modelText(input, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new Error('Bedrock operation requires a UUID');
  return value;
}
export function parseBedrockConnectionPlan(input: unknown): BedrockConnectionPlan {
  const row = modelObject(input);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'bedrock-intent' ||
    Object.keys(row).some(
      (key) =>
        !['schemaVersion', 'kind', 'job', 'artifact', 'profile', 'selection', 'access'].includes(
          key,
        ),
    )
  )
    throw new Error('Unsupported Bedrock connection plan');
  const job = parseBedrockJob(row.job);
  const artifact = parseModelArtifactPin(row.artifact);
  const profile = modelObject(row.profile);
  if (
    Object.keys(profile).some((key) => !['arn', 'id'].includes(key)) ||
    typeof profile.arn !== 'string' ||
    !profile.arn.startsWith(
      `arn:${job.target.stackId.split(':')[1]}:iam::${job.target.account}:instance-profile/`,
    ) ||
    typeof profile.id !== 'string' ||
    !/^AIPA[A-Z0-9]{12,124}$/.test(profile.id)
  )
    throw new Error('Bedrock IAM preview belongs to another host');
  const { selection, access } = parseBedrockGrantPlan(
    { selection: row.selection, access: row.access },
    job.target,
    profile as unknown as RecoverySource['profile'],
  );
  if (selection.discoveryRegion !== job.inferenceRegion)
    throw new Error('Bedrock IAM and native inference regions differ');
  return {
    schemaVersion: 1,
    kind: 'bedrock-intent',
    job,
    artifact,
    profile: profile as unknown as RecoverySource['profile'],
    selection,
    access,
  };
}
async function dispatch(
  ctx: CommandContext,
  job: BedrockJob,
  pin: ModelArtifactPin,
  mode: BedrockWorkerMode,
  signal?: AbortSignal,
) {
  const result = await executeSsm(
    job.target.instanceId,
    ctx.target,
    [bedrockRemoteCommand({ pin, job, mode })],
    { executionSeconds: 960, signal },
  );
  try {
    return parseBedrockResult(JSON.parse(result.stdout), job, mode);
  } catch {
    throw new Error(
      'Bedrock worker returned unsupported or identity-mismatched metadata; private output was not published',
    );
  }
}
/** Caller holds the hosting deployment lock. Read a fresh supported native
 * connection without installing, refreshing, or adopting local desired state. */
export async function observeBedrockOnSource(
  ctx: CommandContext,
  source: RecoverySource,
  pin: ModelArtifactPin,
  inferenceRegion: string,
  signal?: AbortSignal,
) {
  const job = parseBedrockJob({
    schemaVersion: 1,
    kind: 'bedrock-connection',
    operationId: randomUUID(),
    target: {
      deploymentName: ctx.name,
      stackId: source.stackId,
      instanceId: source.instanceId,
      roleId: source.role.id,
      account: ctx.target.account,
      region: ctx.target.region,
    },
    runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
    inferenceRegion,
    expectedHash: 'inspection',
    allowRestart: false,
    acceptPluginCapabilities: false,
    plugin: BEDROCK_PLUGIN,
  });
  const result = await dispatch(ctx, job, pin, 'inspect', signal);
  if (
    !result.observed?.configured ||
    !result.observed.pluginVerified ||
    !result.observed.roleEnvironmentVerified
  )
    throw new Error(
      'Bedrock role provider is not configured in this inference region; run providers enable-bedrock explicitly before selecting its models',
    );
  return result.observed;
}
const owner = (plan: BedrockConnectionPlan): ControlFence => ({
  schemaVersion: 1,
  kind: 'bedrock-connection',
  operationId: plan.job.operationId,
  requestDigest: bedrockJobDigest(plan.job),
  artifactDigest: plan.artifact.digest,
});
function recordPath(operationId: string) {
  return path.join(getConfigRoot(), 'bedrock-operations', uuid(operationId), 'request.json');
}
export async function loadBedrockConnection(operationId: string) {
  const filename = recordPath(operationId);
  await assertDirectoryChain(path.dirname(filename), getConfigRoot(), false);
  return parseBedrockConnectionPlan(await privateModelJson(filename));
}
export class BedrockOperationError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly commandId?: string,
  ) {
    super(
      `Bedrock operation ${operationId} is unconfirmed. Inspect its native maintenance and auxiliary IAM stack before another mutation; do not replay it.${commandId ? ` SSM command: ${commandId}.` : ''}`,
    );
    this.name = 'BedrockOperationError';
  }
}
/** Deliberate provider preview: metadata-only AWS route resolution and native
 * read-only preflight, followed by one IAM-only review change set. Caller must
 * cancel it when declining. No root stack update, inference or model choice. */
export async function prepareBedrockConnection(
  ctx: CommandContext,
  options: {
    inferenceRegion: string;
    models?: string[];
    allowRestart?: boolean;
    acceptPluginCapabilities?: boolean;
    operationId?: string;
    signal?: AbortSignal;
  },
): Promise<BedrockConnectionPlan> {
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx);
    const target = {
      deploymentName: ctx.name,
      stackId: source.stackId,
      instanceId: source.instanceId,
      roleId: source.role.id,
      account: ctx.target.account,
      region: ctx.target.region,
    };
    const pending = await readControlFence(target);
    if (pending)
      throw new Error(
        `Native operation ${pending.operationId} remains unresolved; inspect it before enabling Bedrock`,
      );
    const job = parseBedrockJob({
      schemaVersion: 1,
      kind: 'bedrock-connection',
      operationId: options.operationId ?? randomUUID(),
      target,
      runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
      inferenceRegion: options.inferenceRegion,
      expectedHash: 'preview',
      allowRestart: options.allowRestart ?? false,
      acceptPluginCapabilities: options.acceptPluginCapabilities ?? false,
      plugin: BEDROCK_PLUGIN,
    });
    const artifact = await packagedModelArtifact();
    await deliverModelArtifact(source.instanceId, ctx.target, artifact, options.signal);
    const pin = pinModelArtifact(artifact);
    // Preview delivery is immutable too. Its placeholder revision must never
    // occupy the final mutation ID's create-only host request path.
    const observed = await dispatch(
      ctx,
      { ...job, operationId: randomUUID(), allowRestart: false, acceptPluginCapabilities: false },
      pin,
      'preview',
      options.signal,
    );
    job.expectedHash = modelText(observed.configHash);
    const models = [...new Set(options.models ?? [])];
    if (models.length > 256)
      throw new Error('Bedrock permission preview has too many model routes');
    const routes = [];
    for (const model of models)
      routes.push(
        await resolveBedrockRoute(ctx.target, model, job.inferenceRegion, options.signal),
      );
    const selection = await planBedrockAccessExtension(
      ctx,
      { discoveryRegion: job.inferenceRegion, routes },
      { signal: options.signal },
    );
    const access = await previewBedrockAccess(ctx, selection, { signal: options.signal });
    return parseBedrockConnectionPlan({
      schemaVersion: 1,
      kind: 'bedrock-intent',
      job,
      artifact: pin,
      profile: source.profile,
      selection,
      access,
    });
  });
}
export async function cancelBedrockConnection(ctx: CommandContext, input: BedrockConnectionPlan) {
  const plan = parseBedrockConnectionPlan(input);
  context(ctx, plan.job);
  return withDeploymentLock(ctx, () => discardBedrockAccessPreview(ctx, plan.access));
}
async function settle(plan: BedrockConnectionPlan, result: BedrockResult) {
  if (
    result.maintenanceHeld !== false ||
    !['complete', 'unchanged', 'rolled-back'].includes(result.phase)
  )
    return;
  await writeControlRecord(
    path.join(path.dirname(recordPath(plan.job.operationId)), 'settled.json'),
    { ...owner(plan), phase: result.phase },
    true,
  );
  await releaseControlFence(plan.job.target, owner(plan));
}
function recordConfirmedConnection(
  ctx: CommandContext,
  plan: BedrockConnectionPlan,
  result: BedrockResult,
) {
  if (
    result.phase !== 'complete' ||
    !result.observed?.configured ||
    result.maintenanceHeld !== false
  )
    return;
  recordDeploymentState(
    ctx,
    { stackId: plan.job.target.stackId, stackName: ctx.config.stack.name },
    {
      bedrockConnection: {
        authMode: 'instance-role',
        inferenceRegion: plan.job.inferenceRegion,
        operationId: plan.job.operationId,
        checkedAt: result.observed.checkedAt,
      },
    },
  );
}
/** Durable intent precedes IAM application and host dispatch. IAM failures keep
 * the exact change-set identity inspectable; they do not authorize a replay. */
export async function applyBedrockConnection(
  ctx: CommandContext,
  input: BedrockConnectionPlan,
  options: { signal?: AbortSignal } = {},
): Promise<BedrockResult> {
  const plan = parseBedrockConnectionPlan(input);
  context(ctx, plan.job);
  if (!plan.job.allowRestart || !plan.job.acceptPluginCapabilities)
    throw new Error(
      'Bedrock enablement requires explicit controlled restart and exact plugin-capability approval',
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
      throw new Error('Pinned provider worker is absent; prepare a fresh preview');
    const pending = await readControlFence(plan.job.target);
    if (pending)
      throw new Error(
        `Native operation ${pending.operationId} is already recorded and unresolved; inspect it before another change`,
      );
    bedrockRemoteCommand({ pin: plan.artifact, job: plan.job, mode: 'execute' });
    await writeControlRecord(recordPath(plan.job.operationId), plan);
    await writeControlRecord(controlFencePath(plan.job.target), owner(plan));
    try {
      await applyBedrockAccess(ctx, plan.selection, plan.access, { signal: options.signal });
      await writeControlRecord(
        path.join(path.dirname(recordPath(plan.job.operationId)), 'iam-applied.json'),
        { ...owner(plan), templateDigest: plan.access.templateDigest },
        true,
      );
      const result = await dispatch(ctx, plan.job, plan.artifact, 'execute', options.signal);
      await settle(plan, result);
      recordConfirmedConnection(ctx, plan, result);
      return result;
    } catch (error) {
      throw new BedrockOperationError(
        plan.job.operationId,
        error instanceof RemoteCommandError ? error.commandId : undefined,
      );
    }
  });
}
/** Inspection never repeats plugin/config writes or reexecutes a change set.
 * Explicit acceptance first proves the exact current IAM route union again. */
export async function inspectBedrockConnection(
  ctx: CommandContext,
  operationId: string,
  options: { accept?: 'configured' | 'previous'; signal?: AbortSignal } = {},
): Promise<BedrockResult> {
  return withDeploymentLock(ctx, async () => {
    const plan = await loadBedrockConnection(operationId);
    context(ctx, plan.job);
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
        'Original provider worker is unavailable; inspection cannot replace its code',
      );
    if (options.accept === 'configured') {
      const actual = await inspectBedrockAccess(ctx, { signal: options.signal });
      if (
        !actual ||
        actual.discoveryRegion !== plan.selection.discoveryRegion ||
        !plan.selection.routes.every((route) =>
          actual.routes.some((value) => isDeepStrictEqual(value, route)),
        )
      )
        throw new Error('Bedrock IAM grants are not verified for the approved route union');
    }
    const result = await dispatch(
      ctx,
      plan.job,
      plan.artifact,
      options.accept === 'configured'
        ? 'accept-configured'
        : options.accept === 'previous'
          ? 'accept-previous'
          : 'inspect',
      options.signal,
    );
    await settle(plan, result);
    if (options.accept === 'configured') recordConfirmedConnection(ctx, plan, result);
    return result;
  });
}
