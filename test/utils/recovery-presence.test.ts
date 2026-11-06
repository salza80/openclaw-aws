import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { backupJob } from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({ cfn: vi.fn(), ec2: vi.fn(), close: vi.fn() }));
vi.mock('@aws-sdk/client-cloudformation', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-cloudformation')>()),
  CloudFormationClient: class {
    send = mocks.cfn;
    destroy = mocks.close;
  },
}));
vi.mock('@aws-sdk/client-ec2', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-ec2')>()),
  EC2Client: class {
    send = mocks.ec2;
    destroy = mocks.close;
  },
}));
import { inspectRecoveryPresence } from '../../src/aws/recovery-presence.js';
const target = {
  ...testTarget,
  region: 'eu-central-1',
  arn: 'arn:aws:iam::123456789012:role/operator',
};
const source = backupJob.source;
const stack = {
  StackId: source.stackId,
  StackName: 'OpenclawStack-alpha',
  StackStatus: 'CREATE_COMPLETE',
};
const missingStack = () =>
  Object.assign(Error(`Stack with id ${source.stackId} does not exist`), {
    name: 'ValidationError',
  });
const instance = (id = source.instanceId, state = 'running') => ({
  Reservations: [
    { OwnerId: target.account, Instances: [{ InstanceId: id, State: { Name: state } }] },
  ],
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.cfn.mockImplementation(async (command) =>
    command instanceof DescribeStacksCommand
      ? { Stacks: [stack] }
      : {
          StackResourceSummaries: [
            {
              ResourceType: 'AWS::EC2::Instance',
              PhysicalResourceId: source.instanceId,
              ResourceStatus: 'CREATE_COMPLETE',
            },
          ],
        },
  );
  mocks.ec2.mockResolvedValue(instance());
});
describe('immutable source presence before restore', () => {
  it('requires both deleted/missing stack and terminated/missing instance before certifying absence', async () => {
    mocks.cfn.mockRejectedValueOnce(missingStack());
    mocks.ec2.mockRejectedValueOnce(
      Object.assign(Error('gone'), { name: 'InvalidInstanceID.NotFound' }),
    );
    await expect(inspectRecoveryPresence(target, source)).resolves.toEqual({
      kind: 'gone',
      stack: 'missing',
      archivedInstance: 'missing',
    });
    mocks.cfn.mockResolvedValueOnce({ Stacks: [{ ...stack, StackStatus: 'DELETE_COMPLETE' }] });
    mocks.ec2.mockResolvedValueOnce(instance(source.instanceId, 'terminated'));
    await expect(inspectRecoveryPresence(target, source)).resolves.toEqual({
      kind: 'gone',
      stack: 'deleted',
      archivedInstance: 'terminated',
    });
  });
  it('finds a retained running or stopped source even after its stack was deleted', async () => {
    for (const state of ['running', 'stopped']) {
      mocks.cfn.mockRejectedValueOnce(missingStack());
      mocks.ec2.mockResolvedValueOnce(instance(source.instanceId, state));
      await expect(inspectRecoveryPresence(target, source)).resolves.toMatchObject({
        kind: 'retained-host',
        state,
      });
    }
  });
  it('queries the old immutable ARN rather than a newly reused deployment name', async () => {
    await expect(inspectRecoveryPresence(target, source)).resolves.toMatchObject({
      kind: 'live',
      instanceId: source.instanceId,
      changedSinceBackup: false,
    });
    expect(mocks.cfn.mock.calls[0][0].input.StackName).toBe(source.stackId);
    expect(mocks.cfn.mock.calls[1][0]).toBeInstanceOf(ListStackResourcesCommand);
  });
  it('finds the current source after an instance replacement', async () => {
    const replacement = 'i-11111111111111111';
    mocks.cfn.mockResolvedValueOnce({ Stacks: [stack] }).mockResolvedValueOnce({
      StackResourceSummaries: [
        {
          ResourceType: 'AWS::EC2::Instance',
          PhysicalResourceId: replacement,
          ResourceStatus: 'UPDATE_COMPLETE',
        },
      ],
    });
    mocks.ec2
      .mockResolvedValueOnce(instance(source.instanceId, 'terminated'))
      .mockResolvedValueOnce(instance(replacement));
    await expect(inspectRecoveryPresence(target, source)).resolves.toMatchObject({
      kind: 'live',
      instanceId: replacement,
      changedSinceBackup: true,
    });
  });
  it('refuses to overlook a retained old host when a replacement also exists', async () => {
    mocks.cfn.mockResolvedValueOnce({ Stacks: [stack] }).mockResolvedValueOnce({
      StackResourceSummaries: [
        {
          ResourceType: 'AWS::EC2::Instance',
          PhysicalResourceId: 'i-11111111111111111',
          ResourceStatus: 'UPDATE_COMPLETE',
        },
      ],
    });
    await expect(inspectRecoveryPresence(target, source)).resolves.toMatchObject({
      kind: 'retained-host',
      instanceId: source.instanceId,
    });
  });
  it('does not treat denied stack/instance reads or empty responses as absence', async () => {
    const denied = Object.assign(Error('denied'), { name: 'AccessDenied' });
    mocks.cfn.mockRejectedValueOnce(denied);
    await expect(inspectRecoveryPresence(target, source)).rejects.toBe(denied);
    mocks.ec2.mockRejectedValueOnce(denied);
    await expect(inspectRecoveryPresence(target, source)).rejects.toBe(denied);
    mocks.ec2.mockResolvedValueOnce({ Reservations: [] });
    await expect(inspectRecoveryPresence(target, source)).rejects.toThrow('incomplete');
  });
  it('refuses changing stacks and multiple-host ambiguity', async () => {
    mocks.cfn.mockResolvedValueOnce({ Stacks: [{ ...stack, StackStatus: 'UPDATE_IN_PROGRESS' }] });
    await expect(inspectRecoveryPresence(target, source)).rejects.toThrow('changing');
    mocks.cfn
      .mockResolvedValueOnce({ Stacks: [stack] })
      .mockResolvedValueOnce({ StackResourceSummaries: [] });
    await expect(inspectRecoveryPresence(target, source)).rejects.toThrow('exactly one');
  });
  it('rejects wrong account/region or mismatched source ARN before querying AWS', async () => {
    await expect(
      inspectRecoveryPresence({ ...target, region: 'us-east-1' }, source),
    ).rejects.toThrow('identity');
    await expect(
      inspectRecoveryPresence(target, { ...source, account: '999999999999' }),
    ).rejects.toThrow('identity');
    expect(mocks.cfn).not.toHaveBeenCalled();
    expect(mocks.ec2).not.toHaveBeenCalled();
  });
});
