import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/cli/utils/context.js';
import { modelJob } from '../helpers/model-operation.js';
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  state: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  wait: vi.fn(),
  ssm: vi.fn(),
  pending: vi.fn(),
  lock: vi.fn(),
}));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/cli/utils/ec2.js', () => ({
  getInstanceState: mocks.state,
  startInstance: mocks.start,
  stopInstance: mocks.stop,
  waitForInstanceState: mocks.wait,
}));
vi.mock('../../src/cli/utils/aws.js', () => ({ waitForSSM: mocks.ssm }));
vi.mock('../../src/operations/control-fence.js', () => ({ readControlFence: mocks.pending }));
vi.mock('../../src/operations/lock.js', () => ({ withDeploymentLock: mocks.lock }));
import { prepareInstancePower, applyInstancePower } from '../../src/operations/instances.js';
const ctx = {
  name: modelJob.target.deploymentName,
  config: {},
  target: { account: modelJob.target.account, region: modelJob.target.region },
} as CommandContext;
const source = {
  stackId: modelJob.target.stackId,
  instanceId: modelJob.target.instanceId,
  role: { id: modelJob.target.roleId },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lock.mockImplementation(async (_ctx, run) => run());
  mocks.source.mockResolvedValue(source);
  mocks.state.mockResolvedValue('stopped');
  mocks.wait.mockResolvedValue(true);
  mocks.ssm.mockResolvedValue(true);
});
describe('shared instance power approvals', () => {
  it('starts exactly the approved immutable instance and reports SSM separately from native health', async () => {
    const plan = await prepareInstancePower(ctx, 'start');
    const result = await applyInstancePower(ctx, plan);
    expect(mocks.start).toHaveBeenCalledWith(source.instanceId, ctx.target);
    expect(result).toMatchObject({ state: 'running', changed: true, ssmReady: true });
    expect(result).not.toHaveProperty('gatewayHealthy');
  });
  it('refuses a replaced instance before any start/stop call', async () => {
    const plan = await prepareInstancePower(ctx, 'start');
    mocks.source.mockResolvedValueOnce({ ...source, instanceId: 'i-00000000000000000' });
    await expect(applyInstancePower(ctx, plan)).rejects.toThrow('replaced');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('does not re-send a start when the same instance already reached the requested state', async () => {
    const plan = await prepareInstancePower(ctx, 'start');
    mocks.state.mockResolvedValue('running');
    await expect(applyInstancePower(ctx, plan)).resolves.toMatchObject({
      state: 'running',
      changed: false,
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('respects deployment locks and unresolved native controls', async () => {
    mocks.lock.mockRejectedValueOnce(new Error('owned by backup'));
    await expect(prepareInstancePower(ctx, 'stop')).rejects.toThrow('backup');
    expect(mocks.source).not.toHaveBeenCalled();
    const plan = await prepareInstancePower(ctx, 'start');
    mocks.pending.mockResolvedValueOnce({ operationId: modelJob.operationId });
    await expect(applyInstancePower(ctx, plan)).rejects.toThrow('pending native');
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
