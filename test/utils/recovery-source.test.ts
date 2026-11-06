import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GetInstanceProfileCommand,
  GetRoleCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam';
const mocks = vi.hoisted(() => ({
  cfn: vi.fn(),
  ec2: vi.fn(),
  iam: vi.fn(),
  destroy: vi.fn(),
  status: vi.fn(),
  remove: vi.fn(),
  removeOwned: vi.fn(),
  guard: vi.fn(),
}));
vi.mock('@aws-sdk/client-cloudformation', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-cloudformation')>()),
  CloudFormationClient: class {
    send = mocks.cfn;
    destroy = mocks.destroy;
  },
}));
vi.mock('@aws-sdk/client-ec2', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-ec2')>()),
  EC2Client: class {
    send = mocks.ec2;
    destroy = mocks.destroy;
  },
}));
vi.mock('@aws-sdk/client-iam', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-iam')>()),
  IAMClient: class {
    send = mocks.iam;
    destroy = mocks.destroy;
  },
}));
vi.mock('../../src/cli/utils/aws.js', () => ({ getStackStatus: mocks.status }));
vi.mock('../../src/operations/state.js', () => ({ assertDeploymentTarget: mocks.guard }));
vi.mock('../../src/aws/auxiliary-stacks.js', () => ({
  removeRecoveryAccessStack: mocks.remove,
  removeOwnedRolePolicyStack: mocks.removeOwned,
}));
import {
  inspectRecoverySource,
  removeSourceRecoveryAccess,
  sourceAccessIdentity,
  sourceHash,
  bedrockAccessStackName,
} from '../../src/aws/recovery-source.js';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';
const target = {
  ...testTarget,
  region: 'eu-central-1',
  arn: 'arn:aws:iam::123456789012:role/operator',
};
const ctx = makeCommandContext({
  target,
  config: { ...makeCommandContext().config, aws: { region: target.region } },
});
const stackId = `arn:aws:cloudformation:eu-central-1:123456789012:stack/${ctx.config.stack.name}/source-guid`;
const role = {
  RoleName: 'source-role',
  Arn: 'arn:aws:iam::123456789012:role/source-role',
  RoleId: 'AROA-SOURCE-IDENTITY',
};
const profile = {
  Arn: 'arn:aws:iam::123456789012:instance-profile/source-profile',
  InstanceProfileId: 'AIPA-SOURCE-IDENTITY',
  InstanceProfileName: 'source-profile',
  Roles: [role],
};
const host = {
  InstanceId: 'i-source',
  State: { Name: 'running' },
  IamInstanceProfile: { Arn: profile.Arn, Id: profile.InstanceProfileId },
  InstanceType: 't3a.small',
  BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-source' } }],
  ImageId: 'ami-source',
  SubnetId: 'subnet-source',
  VpcId: 'vpc-source',
  Architecture: 'x86_64',
};
const resources = [
  { ResourceType: 'AWS::EC2::Instance', PhysicalResourceId: 'i-source' },
  { ResourceType: 'AWS::IAM::Role', PhysicalResourceId: role.RoleName },
  { ResourceType: 'AWS::IAM::InstanceProfile', PhysicalResourceId: profile.InstanceProfileName },
];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue({
    stackId,
    stackName: ctx.config.stack.name,
    stackStatus: 'CREATE_COMPLETE',
    instanceId: host.InstanceId,
  });
  mocks.cfn.mockResolvedValue({ StackResourceSummaries: resources });
  mocks.ec2.mockImplementation(async (command) =>
    command.constructor.name === 'DescribeVolumesCommand'
      ? {
          Volumes: [
            {
              VolumeId: 'vol-source',
              Size: 30,
              Attachments: [{ InstanceId: host.InstanceId, State: 'attached' }],
            },
          ],
        }
      : { Reservations: [{ OwnerId: target.account, Instances: [host] }] },
  );
  mocks.iam.mockImplementation(async (command) => {
    if (command instanceof GetInstanceProfileCommand) return { InstanceProfile: profile };
    if (command instanceof GetRoleCommand) return { Role: role };
    if (command instanceof ListRolePoliciesCommand) return { PolicyNames: [] };
    throw new Error('Unexpected IAM mutation');
  });
});
describe('source recovery ownership', () => {
  it('binds the stack, single host, owned profile and stable role identity before permission planning', async () => {
    expect(await inspectRecoverySource(ctx)).toMatchObject({
      stackId,
      instanceId: host.InstanceId,
      role: { name: role.RoleName, arn: role.Arn, id: role.RoleId },
      profile: { arn: profile.Arn, id: profile.InstanceProfileId },
      instance: { type: 't3a.small', architecture: 'x86_64' },
    });
    expect(mocks.guard).toHaveBeenCalled();
    expect(mocks.ec2.mock.calls[1][0].input.Filters).toContainEqual({
      Name: 'iam-instance-profile.arn',
      Values: [profile.Arn],
    });
  });
  it('rejects a profile shared with another host', async () => {
    mocks.ec2
      .mockResolvedValueOnce({ Reservations: [{ OwnerId: target.account, Instances: [host] }] })
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [host, { ...host, InstanceId: 'i-unrelated' }] }],
      });
    await expect(inspectRecoverySource(ctx)).rejects.toThrow(/shared/);
  });
  it.each([
    { InstanceProfile: { ...profile, InstanceProfileId: 'recreated-profile' } },
    { InstanceProfile: { ...profile, InstanceProfileName: 'foreign-profile' } },
    { InstanceProfile: { ...profile, Roles: [{ ...role, RoleName: 'foreign-role' }] } },
  ])('rejects an unowned or substituted instance profile/role', async (result) => {
    mocks.iam.mockResolvedValue(result);
    await expect(inspectRecoverySource(ctx)).rejects.toThrow(/profile|role/);
  });
  it('rejects a deleted and recreated role with the same name/ARN', async () => {
    mocks.iam
      .mockResolvedValueOnce({ InstanceProfile: profile })
      .mockResolvedValueOnce({ Role: { ...role, RoleId: 'DIFFERENT-UNIQUE-ID' } });
    await expect(inspectRecoverySource(ctx)).rejects.toThrow(/role identity changed/);
  });
  it('does not turn denied ownership checks into provisioning or cleanup', async () => {
    const error = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    mocks.cfn.mockRejectedValue(error);
    await expect(inspectRecoverySource(ctx)).rejects.toBe(error);
    expect(mocks.ec2).not.toHaveBeenCalled();
    expect(mocks.iam).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('requires live source disk capacity before certifying recovery sizing', async () => {
    mocks.ec2.mockImplementation(async (command) =>
      command.constructor.name === 'DescribeVolumesCommand'
        ? { Volumes: [] }
        : { Reservations: [{ OwnerId: target.account, Instances: [host] }] },
    );
    await expect(inspectRecoverySource(ctx)).rejects.toThrow('disk capacity');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('removes only access stacks discoverable through this source role and source identity', async () => {
    const owned = `OpenclawRecovery-${sourceHash(stackId)}-vault-id`;
    mocks.iam.mockImplementation(async (command) =>
      command instanceof GetRoleCommand
        ? { Role: role }
        : { PolicyNames: [owned, 'unrelated-policy', 'OpenclawRecovery-other-source-vault'] },
    );
    await removeSourceRecoveryAccess(target, stackId);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(target, {
      stackName: owned,
      identity: sourceAccessIdentity(stackId, role.RoleId),
      roleName: role.RoleName,
    });
  });
  it('preserves source resources if access-policy cleanup fails', async () => {
    const failure = new Error('cleanup denied');
    mocks.iam.mockImplementation(async (command) =>
      command instanceof GetRoleCommand
        ? { Role: role }
        : { PolicyNames: [`OpenclawRecovery-${sourceHash(stackId)}-vault-id`] },
    );
    mocks.remove.mockRejectedValue(failure);
    await expect(removeSourceRecoveryAccess(target, stackId)).rejects.toBe(failure);
    expect(mocks.cfn).toHaveBeenCalledTimes(1); // Inventory only; source deletion belongs to its caller.
  });
  it('completes the policy inventory before removing any access stack', async () => {
    mocks.iam
      .mockResolvedValueOnce({ Role: role })
      .mockResolvedValueOnce({
        PolicyNames: [`OpenclawRecovery-${sourceHash(stackId)}-first`],
        IsTruncated: true,
        Marker: 'next',
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('denied second page'), { name: 'AccessDenied' }),
      );
    await expect(removeSourceRecoveryAccess(target, stackId)).rejects.toThrow('denied second page');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('removes the exact owned Bedrock policy before host-role teardown, leaving other roles alone', async () => {
    const own = bedrockAccessStackName(stackId, role.RoleId!);
    const other = bedrockAccessStackName(stackId, 'DIFFERENTROLE');
    mocks.iam.mockImplementation(async (command) =>
      command instanceof GetRoleCommand
        ? { Role: role }
        : { PolicyNames: [own, other, 'unrelated-policy'] },
    );
    await removeSourceRecoveryAccess(target, stackId);
    expect(mocks.removeOwned).toHaveBeenCalledExactlyOnceWith(target, {
      kind: 'bedrock-access',
      stackName: own,
      identity: sourceAccessIdentity(stackId, role.RoleId!),
      roleName: role.RoleName,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('also inspects the deterministic Bedrock stack when an unexecuted review has no inline policy', async () => {
    mocks.iam.mockImplementation(async (command) =>
      command instanceof GetRoleCommand ? { Role: role } : { PolicyNames: [] },
    );
    await removeSourceRecoveryAccess(target, stackId);
    expect(mocks.removeOwned).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        kind: 'bedrock-access',
        stackName: bedrockAccessStackName(stackId, role.RoleId!),
      }),
    );
  });
  it('preserves Bedrock model grants when only temporary source-backup access is being revoked', async () => {
    const recovery = `OpenclawRecovery-${sourceHash(stackId)}-vault-id`;
    mocks.iam.mockImplementation(async (command) =>
      command instanceof GetRoleCommand
        ? { Role: role }
        : { PolicyNames: [recovery, bedrockAccessStackName(stackId, role.RoleId!)] },
    );
    await removeSourceRecoveryAccess(target, stackId, { preserveBedrock: true });
    expect(mocks.remove).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ stackName: recovery }),
    );
    expect(mocks.removeOwned).not.toHaveBeenCalled();
  });
  it('handles an explicitly absent role during a partial teardown retry', async () => {
    mocks.iam.mockRejectedValue(
      Object.assign(new Error('role deleted'), { name: 'NoSuchEntityException' }),
    );
    await removeSourceRecoveryAccess(target, stackId);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
