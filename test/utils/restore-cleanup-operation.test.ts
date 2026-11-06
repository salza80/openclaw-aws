import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteStackCommand } from '@aws-sdk/client-cloudformation';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  cf: vi.fn(),
  ssm: vi.fn(),
  parameters: vi.fn(),
  access: vi.fn(),
  waiter: vi.fn(),
  forget: vi.fn(),
  record: {} as Record<string, unknown>,
}));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createCloudFormationClient: () => ({ send: mocks.cf, destroy() {} }),
  createSsmClient: () => ({ send: mocks.ssm, destroy() {} }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-cloudformation')>()),
  waitUntilStackDeleteComplete: mocks.waiter,
}));
vi.mock('../../src/aws/restore-cleanup.js', () => ({ deleteRestoreParameters: mocks.parameters }));
vi.mock('../../src/aws/recovery-source.js', () => ({ removeSourceRecoveryAccess: mocks.access }));
vi.mock('../../src/operations/state.js', () => ({
  assertDeploymentTarget: vi.fn(),
  loadDeploymentState: () => undefined,
  forgetRestoredDeployment: mocks.forget,
}));
vi.mock('../../src/operations/restore-record.js', () => ({
  loadRestoreRecord: () => mocks.record,
}));
vi.mock('../../src/operations/lock.js', () => ({
  withDeploymentLock: async (_ctx: unknown, fn: () => Promise<void>) => fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({
  getConfigPathByName: () => '/unused/config.json',
  getOutputsPathByName: () => '/unused/outputs.json',
  configExistsByName: () => false,
}));
vi.mock('../../src/cli/utils/config-store.js', () => ({ getCurrentName: () => null }));
vi.mock('../../src/aws/target.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/target.js')>()),
  resolveAwsTarget: async () => ({
    ...makeCommandContext().target,
    arn: 'arn:aws:iam::123456789012:user/test',
  }),
}));
import { cleanupRestore } from '../../src/operations/restore-cleanup.js';
const id = '11111111-1111-1111-1111-111111111111';
const stackId = 'arn:aws:cloudformation:us-east-1:123456789012:stack/OpenclawStack-alpha/target';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.record = {
    name: 'alpha',
    config: makeCommandContext().config,
    target: { stackId, instanceId: 'i-0123456789abcdef0' },
  };
  mocks.waiter.mockResolvedValue({ state: 'SUCCESS' });
});
describe('explicit restore cleanup', () => {
  it('deletes an operation-tagged immutable target before cleaning credentials', async () => {
    mocks.cf
      .mockResolvedValueOnce({
        Stacks: [
          {
            StackId: stackId,
            StackStatus: 'ROLLBACK_COMPLETE',
            Tags: [{ Key: 'openclaw-aws:restore-id', Value: id }],
          },
        ],
      })
      .mockResolvedValue({});
    await cleanupRestore(id);
    expect(mocks.cf.mock.calls[1][0]).toBeInstanceOf(DeleteStackCommand);
    expect(mocks.cf.mock.calls[1][0].input.StackName).toBe(stackId);
    expect(mocks.parameters).toHaveBeenCalledWith(expect.anything(), {
      deploymentName: 'alpha',
      deploymentId: stackId,
      operationId: id,
    });
    expect(mocks.waiter.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.parameters.mock.invocationCallOrder[0],
    );
  });
  it('refuses a replacement with the same name before any deletion', async () => {
    mocks.cf.mockResolvedValue({
      Stacks: [
        {
          StackId: stackId + '-replacement',
          Tags: [{ Key: 'openclaw-aws:restore-id', Value: id }],
        },
      ],
    });
    await expect(cleanupRestore(id)).rejects.toThrow('not owned');
    expect(mocks.parameters).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it('retains credentials on failed deletion', async () => {
    mocks.cf.mockResolvedValue({
      Stacks: [
        {
          StackId: stackId,
          StackStatus: 'ROLLBACK_COMPLETE',
          Tags: [{ Key: 'openclaw-aws:restore-id', Value: id }],
        },
      ],
    });
    mocks.waiter.mockRejectedValue(new Error('DELETE_FAILED'));
    await expect(cleanupRestore(id)).rejects.toThrow('DELETE_FAILED');
    expect(mocks.parameters).not.toHaveBeenCalled();
  });
  it('can remove the owned seed after failure before a stack was ever created', async () => {
    mocks.record.target = undefined;
    mocks.cf.mockRejectedValue(
      Object.assign(new Error('Stack with id OpenclawStack-alpha does not exist'), {
        name: 'ValidationError',
      }),
    );
    await cleanupRestore(id);
    expect(mocks.parameters).toHaveBeenCalledWith(expect.anything(), {
      deploymentName: 'alpha',
      deploymentId: undefined,
      operationId: id,
    });
  });
});
