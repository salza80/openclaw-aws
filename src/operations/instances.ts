import type { CommandContext } from '../cli/utils/context.js';
import { inspectRecoverySource } from '../aws/recovery-source.js';
import {
  parseModelHostTarget,
  modelObject,
  type ModelHostTarget,
} from '../openclaw/model-contract.js';
import {
  getInstanceState,
  startInstance,
  stopInstance,
  waitForInstanceState,
} from '../cli/utils/ec2.js';
import { waitForSSM } from '../cli/utils/aws.js';
import { withDeploymentLock } from './lock.js';
import { readControlFence } from './control-fence.js';

export interface InstancePowerPlan {
  schemaVersion: 1;
  action: 'start' | 'stop';
  target: ModelHostTarget;
  before: 'running' | 'stopped';
}
export function parseInstancePowerPlan(input: unknown): InstancePowerPlan {
  const row = modelObject(input);
  if (
    Object.keys(row).some(
      (key) => !['schemaVersion', 'action', 'target', 'before'].includes(key),
    ) ||
    row.schemaVersion !== 1 ||
    !['start', 'stop'].includes(String(row.action)) ||
    !['running', 'stopped'].includes(String(row.before))
  )
    throw new Error('Unsupported instance power plan');
  return {
    schemaVersion: 1,
    action: row.action as InstancePowerPlan['action'],
    before: row.before as InstancePowerPlan['before'],
    target: parseModelHostTarget(row.target),
  };
}
export async function prepareInstancePower(
  ctx: CommandContext,
  action: 'start' | 'stop',
): Promise<InstancePowerPlan> {
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx, { allowStopped: true });
    const before = await getInstanceState(source.instanceId, ctx.target);
    if (before !== 'running' && before !== 'stopped')
      throw new Error(
        'Instance is changing or unavailable; refresh its state before approving a power operation',
      );
    return parseInstancePowerPlan({
      schemaVersion: 1,
      action,
      before,
      target: {
        deploymentName: ctx.name,
        stackId: source.stackId,
        instanceId: source.instanceId,
        roleId: source.role.id,
        account: ctx.target.account,
        region: ctx.target.region,
      },
    });
  });
}
/** CLI and local UI share immutable-target verification and the host lock.
 * EC2 power state is separate from Gateway health and retained storage costs. */
export async function applyInstancePower(
  ctx: CommandContext,
  input: InstancePowerPlan,
  options: { progress?: (message: string) => void; waitForSsm?: boolean } = {},
) {
  const plan = parseInstancePowerPlan(input);
  const target = plan.target;
  if (
    target.deploymentName !== ctx.name ||
    target.account !== ctx.target.account ||
    target.region !== ctx.target.region
  )
    throw new Error('Power approval belongs to another deployment/account/region');
  return withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx, { allowStopped: true });
    if (
      source.stackId !== target.stackId ||
      source.instanceId !== target.instanceId ||
      source.role.id !== target.roleId
    )
      throw new Error('Approved power target was replaced; no instance action was sent');
    if (await readControlFence(target))
      throw new Error(
        'Resolve the pending native control operation before changing instance power',
      );
    const desired = plan.action === 'start' ? 'running' : 'stopped';
    let state = await getInstanceState(target.instanceId, ctx.target);
    if (state !== plan.before && state !== desired)
      throw new Error('Instance state changed after approval; no power action was sent');
    const changed = state !== desired;
    if (changed) {
      options.progress?.(
        plan.action === 'start'
          ? 'Starting the approved EC2 instance...'
          : 'Stopping the approved EC2 instance...',
      );
      await (plan.action === 'start' ? startInstance : stopInstance)(target.instanceId, ctx.target);
      const reached = await waitForInstanceState(
        target.instanceId,
        ctx.target,
        desired,
        plan.action === 'start' ? 180000 : 120000,
      );
      state = reached ? desired : await getInstanceState(target.instanceId, ctx.target);
    }
    let ssmReady: boolean | null = null;
    if (plan.action === 'start' && state === 'running' && options.waitForSsm !== false) {
      options.progress?.('Waiting for the instance to register with SSM...');
      ssmReady = await waitForSSM(target.instanceId, ctx.target, 120000);
    }
    return {
      schemaVersion: 1 as const,
      action: plan.action,
      target,
      changed,
      state: state ?? 'unknown',
      ssmReady,
      checkedAt: new Date().toISOString(),
    };
  });
}
