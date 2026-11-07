import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from '../cli/utils/context.js';
import { getConfigRoot } from '../cli/utils/config.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { inspectRecoverySource, type RecoverySource } from '../aws/recovery-source.js';
import {
  packagedModelArtifact,
  deliverModelArtifact,
  pinModelArtifact,
  parseModelArtifactPin,
  hasModelArtifact,
  type ModelArtifactPin,
} from '../aws/model-artifact.js';
import { teamRemoteCommand } from '../aws/model-delivery.js';
import { executeSsm } from '../aws/ssm.js';
import { modelObject, modelText } from '../openclaw/model-contract.js';
import {
  parseTeamJob,
  teamId,
  teamJobDigest,
  type TeamJob,
  type TeamWorkerMode,
} from '../openclaw/team-contract.js';
import { parseTeamDefinition, type TeamDefinition } from '../openclaw/team-definition.js';
import { parseTeamResult, type TeamResult } from '../openclaw/team-result.js';
import { privateModelJson } from '../openclaw/model-journal.js';
import { loadDeploymentState } from './state.js';
import { withDeploymentLock } from './lock.js';
import { readTeamState, saveTeamState } from './team-state.js';
import {
  readControlFence,
  writeControlRecord,
  releaseControlFence,
  controlFencePath,
  type ControlFence,
} from './control-fence.js';

export interface TeamPlan {
  schemaVersion: 1;
  kind: 'team-intent';
  job: TeamJob;
  artifact: ModelArtifactPin;
  profile: RecoverySource['profile'];
}
export function parseTeamPlan(input: unknown): TeamPlan {
  const row = modelObject(input);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'team-intent' ||
    Object.keys(row).some(
      (key) => !['schemaVersion', 'kind', 'job', 'artifact', 'profile'].includes(key),
    )
  )
    throw new Error('Unsupported team plan');
  const job = parseTeamJob(row.job);
  if (job.action.kind !== 'configure')
    throw new Error('Team plan requires a configuration request');
  const profile = modelObject(row.profile),
    arn = modelText(profile.arn),
    id = modelText(profile.id, 128);
  if (
    Object.keys(profile).some((key) => !['arn', 'id'].includes(key)) ||
    !arn.startsWith(
      `arn:${job.target.stackId.split(':')[1]}:iam::${job.target.account}:instance-profile/`,
    ) ||
    !/^AIPA[A-Z0-9]{12,124}$/.test(id)
  )
    throw new Error('Invalid team host profile');
  return {
    schemaVersion: 1,
    kind: 'team-intent',
    job,
    artifact: parseModelArtifactPin(row.artifact),
    profile: { arn, id },
  };
}
function operationPath(id: string) {
  return path.join(getConfigRoot(), 'team-operations', teamId(id), 'plan.json');
}
function assertContext(ctx: CommandContext, plan: TeamPlan, source: RecoverySource) {
  const target = plan.job.target;
  if (
    ctx.name !== target.deploymentName ||
    ctx.target.account !== target.account ||
    ctx.target.region !== target.region ||
    source.stackId !== target.stackId ||
    source.instanceId !== target.instanceId ||
    source.role.id !== target.roleId ||
    !isDeepStrictEqual(source.profile, plan.profile)
  )
    throw new Error('Team host identity changed');
}
function fence(plan: TeamPlan): ControlFence {
  return {
    schemaVersion: 1,
    kind: 'native-team',
    operationId: plan.job.operationId,
    requestDigest: teamJobDigest(plan.job),
    artifactDigest: plan.artifact.digest,
  };
}
async function dispatch(
  ctx: CommandContext,
  job: TeamJob,
  artifact: ModelArtifactPin,
  mode: TeamWorkerMode,
  signal?: AbortSignal,
): Promise<TeamResult> {
  const result = await executeSsm(
    job.target.instanceId,
    ctx.target,
    [teamRemoteCommand({ job, pin: artifact, mode })],
    { executionSeconds: 960, signal },
  );
  try {
    return parseTeamResult(JSON.parse(result.stdout), job);
  } catch {
    throw new Error('Team result was not confirmed; private worker output was withheld');
  }
}
/** Preview reuses the current dedicated host; it never provisions another EC2. */
export async function prepareTeam(
  ctx: CommandContext,
  options: {
    definition: TeamDefinition;
    teamId?: string;
    operationId?: string;
    allowRestart?: boolean;
    signal?: AbortSignal;
  },
): Promise<TeamPlan> {
  const definition = parseTeamDefinition(options.definition);
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx);
    const job = parseTeamJob({
      schemaVersion: 1,
      kind: 'native-team',
      teamId: options.teamId ?? randomUUID(),
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
      definition,
      bedrockRole: Boolean(loadDeploymentState(ctx)?.bedrockConnection),
      action: { kind: 'preview' },
    });
    const pending = await readControlFence(job.target);
    if (pending)
      throw new Error(
        `Native control operation ${pending.operationId} is pending; inspect it first`,
      );
    const artifact = await packagedModelArtifact();
    await deliverModelArtifact(source.instanceId, ctx.target, artifact, options.signal);
    const pin = pinModelArtifact(artifact);
    const observed = await dispatch(ctx, job, pin, 'execute', options.signal);
    if (!observed.preflight) throw new Error('Team preview has no native preflight');
    if (observed.preflight.reloadOff && !options.allowRestart)
      throw new Error('Native reload is off; repeat with explicit controlled restart consent');
    return parseTeamPlan({
      schemaVersion: 1,
      kind: 'team-intent',
      artifact: pin,
      profile: source.profile,
      job: {
        ...job,
        operationId: options.operationId ?? randomUUID(),
        action: {
          kind: 'configure',
          ...observed.preflight,
          allowRestart: options.allowRestart ?? false,
        },
      },
    });
  });
}
async function settleLocal(plan: TeamPlan, result: TeamResult) {
  if (!isDeepStrictEqual(await readControlFence(plan.job.target), fence(plan))) return;
  if (!['complete', 'aborted'].includes(result.recordedPhase) || result.maintenanceHeld) return;
  if (result.recordedPhase === 'complete') {
    if (!result.requestedConfigurationVerified)
      throw new Error('Completed team is not currently verified');
    await writeControlRecord(
      path.join(path.dirname(operationPath(plan.job.operationId)), 'complete.json'),
      {
        schemaVersion: 1,
        teamId: plan.job.teamId,
        target: plan.job.target,
        definition: plan.job.definition,
        members: result.members,
      },
      true,
    );
    await saveTeamState(plan.job, { rebindVerifiedTarget: true });
  }
  await releaseControlFence(plan.job.target, fence(plan));
}
export async function queryTeam(ctx: CommandContext, signal?: AbortSignal) {
  const saved = await readTeamState(ctx.name);
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx);
    if (
      source.stackId !== saved.target.stackId ||
      source.instanceId !== saved.target.instanceId ||
      source.role.id !== saved.target.roleId
    )
      throw new Error('Team host identity changed');
    const artifact = await packagedModelArtifact();
    await deliverModelArtifact(source.instanceId, ctx.target, artifact, signal);
    const job = parseTeamJob({
      schemaVersion: 1,
      kind: 'native-team',
      operationId: randomUUID(),
      teamId: saved.teamId,
      target: saved.target,
      definition: saved.definition,
      runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
      bedrockRole: Boolean(loadDeploymentState(ctx)?.bedrockConnection),
      action: { kind: 'status' },
    });
    const result = await dispatch(ctx, job, pinModelArtifact(artifact), 'execute', signal);
    return {
      ...result,
      pendingControl: (await readControlFence(saved.target))?.operationId ?? null,
    };
  });
}
export async function applyTeam(ctx: CommandContext, input: TeamPlan, signal?: AbortSignal) {
  const plan = parseTeamPlan(input);
  return withDeploymentLock(ctx, async () => {
    assertContext(ctx, plan, await inspectRecoverySource(ctx));
    if (await readControlFence(plan.job.target))
      throw new Error('Another native operation is pending; inspect its original request');
    await writeControlRecord(operationPath(plan.job.operationId), plan);
    await writeControlRecord(controlFencePath(plan.job.target), fence(plan));
    // Desired ownership metadata is available for a new explicit preview after
    // abort. Status still requires the live host receipt; this is not readiness.
    await saveTeamState(plan.job, { rebindVerifiedTarget: true });
    // Durable local intent precedes dispatch. A lost SSM reply leaves this fence.
    const result = await dispatch(ctx, plan.job, plan.artifact, 'execute', signal);
    await settleLocal(plan, result);
    return result;
  });
}
export async function inspectTeamOperation(
  ctx: CommandContext,
  operationId: string,
  options: { mode?: 'inspect' | 'resume' | 'abort'; signal?: AbortSignal } = {},
) {
  const plan = parseTeamPlan(await privateModelJson(operationPath(operationId)));
  return withDeploymentLock(ctx, async () => {
    assertContext(ctx, plan, await inspectRecoverySource(ctx));
    const pending = await readControlFence(plan.job.target);
    if (
      options.mode !== undefined &&
      options.mode !== 'inspect' &&
      pending &&
      !isDeepStrictEqual(pending, fence(plan))
    )
      throw new Error('Another native operation owns this host');
    if (
      !(await hasModelArtifact(
        plan.job.target.instanceId,
        ctx.target,
        plan.artifact,
        options.signal,
      ))
    )
      throw new Error('Original pinned team worker is absent; no replacement write was dispatched');
    const result = await dispatch(
      ctx,
      plan.job,
      plan.artifact,
      options.mode ?? 'inspect',
      options.signal,
    );
    await settleLocal(plan, result);
    return { plan, result };
  });
}
