import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Stack, CfnResource } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
const mocks = vi.hoisted(() => ({
  cf: vi.fn(),
  ec2: vi.fn(),
  iam: vi.fn(),
  ssm: vi.fn(),
  removeAccess: vi.fn(),
  resources: vi.fn(),
  wait: vi.fn(),
}));
vi.mock('@aws-sdk/client-cloudformation', async (original) => ({
  ...(await original<object>()),
  CloudFormationClient: class {
    send = mocks.cf;
    destroy() {}
  },
  waitUntilStackDeleteComplete: mocks.wait,
}));
vi.mock('@aws-sdk/client-ec2', async (original) => ({
  ...(await original<object>()),
  EC2Client: class {
    send = mocks.ec2;
    destroy() {}
  },
}));
vi.mock('@aws-sdk/client-iam', async (original) => ({
  ...(await original<object>()),
  IAMClient: class {
    send = mocks.iam;
    destroy() {}
  },
}));
vi.mock('@aws-sdk/client-ssm', async (original) => ({
  ...(await original<object>()),
  SSMClient: class {
    send = mocks.ssm;
    destroy() {}
  },
}));
vi.mock('../../src/aws/recovery-source.js', async (original) => ({
  ...(await original<object>()),
  removeSourceRecoveryAccess: mocks.removeAccess,
  sourceResources: mocks.resources,
}));
import {
  planArchiveDeletion,
  assertArchiveDeletionCurrent,
  deleteArchivedStack,
  auditArchivedCompute,
  deleteArchivedParameters,
} from '../../src/aws/archive-deletion.js';
import { backupSource } from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const target = { ...testTarget, region: 'eu-central-1' };
const volumeId = 'vol-0123456789abcdef0';
let status: string;
let template: object;
let parameters: {
  Name: string;
  ARN: string;
  Version: number;
  Type: string;
  LastModifiedDate: Date;
}[];
let volumeGone: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  status = 'CREATE_COMPLETE';
  volumeGone = false;
  template = {
    Resources: { Host: { Type: 'AWS::EC2::Instance' }, Role: { Type: 'AWS::IAM::Role' } },
  };
  parameters = ['gateway-token', 'providers/openrouter-api-key/api-key'].map((name) => ({
    Name: '/openclaw/alpha/' + name,
    ARN: 'arn:aws:ssm:eu-central-1:123456789012:parameter/openclaw/alpha/' + name,
    Type: 'SecureString',
    Version: 1,
    LastModifiedDate: new Date('2026-11-06T00:00:00Z'),
  }));
  mocks.cf.mockImplementation(async (command) => {
    if (command.constructor.name === 'GetTemplateCommand') return { TemplateBody: template };
    if (command.constructor.name === 'DescribeStacksCommand')
      return { Stacks: [{ StackId: backupSource.stackId, StackStatus: status }] };
    if (command.constructor.name === 'DeleteStackCommand') {
      status = 'DELETE_COMPLETE';
      return {};
    }
    throw new Error('unexpected CloudFormation operation');
  });
  mocks.ec2.mockImplementation(async (command) => {
    if (command.constructor.name === 'DescribeInstancesCommand')
      return {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: backupSource.instanceId,
                State: { Name: status === 'DELETE_COMPLETE' ? 'terminated' : 'running' },
                IamInstanceProfile: { Arn: backupSource.profile.arn },
                RootDeviceName: '/dev/sda1',
                BlockDeviceMappings: [
                  {
                    DeviceName: '/dev/sda1',
                    Ebs: { VolumeId: volumeId, DeleteOnTermination: true },
                  },
                ],
              },
            ],
          },
        ],
      };
    if (command.constructor.name === 'DescribeVolumesCommand') {
      if (volumeGone) throw Object.assign(new Error('missing'), { name: 'InvalidVolume.NotFound' });
      return {
        Volumes: [
          {
            VolumeId: volumeId,
            Encrypted: true,
            Attachments: [{ InstanceId: backupSource.instanceId }],
          },
        ],
      };
    }
    throw new Error('unexpected EC2 operation');
  });
  mocks.iam.mockImplementation(async (command) =>
    command.constructor.name === 'GetRoleCommand'
      ? { Role: { RoleId: backupSource.role.id } }
      : { InstanceProfile: { InstanceProfileId: backupSource.profile.id } },
  );
  mocks.ssm.mockImplementation(async (command) => {
    if (command.constructor.name === 'DescribeParametersCommand') return { Parameters: parameters };
    if (command.constructor.name === 'DeleteParameterCommand') {
      parameters = parameters.filter((p) => p.Name !== command.input.Name);
      return {};
    }
    throw new Error('Unexpected secret-value read or credential write');
  });
  mocks.removeAccess.mockResolvedValue(undefined);
  mocks.resources.mockResolvedValue([
    { ResourceType: 'AWS::EC2::Instance', PhysicalResourceId: backupSource.instanceId },
  ]);
  mocks.wait.mockResolvedValue({ state: 'SUCCESS' });
});
const plan = () => planArchiveDeletion(target, 'alpha', backupSource);
const deletes = () =>
  mocks.cf.mock.calls.filter(([command]) => command.constructor.name === 'DeleteStackCommand');
describe('owned archive AWS teardown', () => {
  it('accepts the metadata emitted by normal CDK deployment synthesis', async () => {
    const app = new App({ context: { 'aws:cdk:version-reporting': true } });
    const stack = new Stack(app, 'ArchiveMetadata', {
      env: { account: target.account, region: target.region },
    });
    new CfnResource(stack, 'Host', { type: 'AWS::EC2::Instance' });
    template = Template.fromStack(stack).toJSON();
    expect(
      Object.values((template as { Resources: Record<string, { Type: string }> }).Resources).map(
        (r) => r.Type,
      ),
    ).toContain('AWS::CDK::Metadata');
    await expect(plan()).resolves.toMatchObject({ volumeId });
  });
  it('previews only metadata, the owned root disk, and finite unretained supported resources', async () => {
    const approved = await plan();
    expect(approved.volumeId).toBe(volumeId);
    expect(approved.parameters).toHaveLength(2);
    expect(approved.templateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      mocks.ssm.mock.calls.every(
        ([command]) => command.constructor.name === 'DescribeParametersCommand',
      ),
    ).toBe(true);
    expect(deletes()).toHaveLength(0);
  });
  it('refuses retained or unsupported resources before creating an archive', async () => {
    template = { Resources: { Host: { Type: 'AWS::EC2::Instance', DeletionPolicy: 'Retain' } } };
    await expect(plan()).rejects.toThrow(/retained resources/);
    template = { Resources: { Database: { Type: 'AWS::RDS::DBInstance' } } };
    await expect(plan()).rejects.toThrow(/unsupported/);
    expect(deletes()).toHaveLength(0);
  });
  it('refuses an extra/unowned disk and an unexpected credential namespace', async () => {
    const original = mocks.ec2.getMockImplementation()!;
    mocks.ec2.mockImplementation(async (command) => {
      const row = await original(command);
      if (command.constructor.name === 'DescribeInstancesCommand')
        row.Reservations[0].Instances[0].BlockDeviceMappings.push({
          DeviceName: '/dev/sdb',
          Ebs: { VolumeId: 'vol-fffffffffffffffff', DeleteOnTermination: false },
        });
      return row;
    });
    await expect(plan()).rejects.toThrow(/single auto-deleted root disk/);
    mocks.ec2.mockImplementation(original);
    parameters.push({
      ...parameters[0],
      Name: '/openclaw/alpha/unrelated',
      ARN: 'arn:aws:ssm:eu-central-1:123456789012:parameter/openclaw/alpha/unrelated',
    });
    await expect(plan()).rejects.toThrow(/unsupported or ambiguous/);
    expect(deletes()).toHaveLength(0);
  });
  it('rechecks the disk, template and credential versions before commitment', async () => {
    const approved = await plan();
    parameters[0].Version++;
    await expect(assertArchiveDeletionCurrent(target, approved)).rejects.toThrow(
      /ownership changed/,
    );
    expect(deletes()).toHaveLength(0);
  });
  it('deletes only the immutable original ARN after removing its scoped policy stacks', async () => {
    const approved = await plan();
    await deleteArchivedStack(target, approved);
    expect(deletes()[0][0].input.StackName).toBe(backupSource.stackId);
    expect(mocks.removeAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cf.mock.invocationCallOrder[
        mocks.cf.mock.calls.findIndex(
          ([command]) => command.constructor.name === 'DeleteStackCommand',
        )
      ],
    );
    await deleteArchivedStack(target, approved);
    expect(deletes()).toHaveLength(1);
  });
  it('does not delete a replacement instance/role or a stack whose ownership changed', async () => {
    const approved = await plan();
    mocks.resources.mockResolvedValueOnce([
      { ResourceType: 'AWS::EC2::Instance', PhysicalResourceId: 'i-fffffffffffffffff' },
    ]);
    await expect(deleteArchivedStack(target, approved)).rejects.toThrow(/instance was replaced/);
    mocks.iam.mockResolvedValueOnce({ Role: { RoleId: 'foreign-role-id' } });
    await expect(deleteArchivedStack(target, approved)).rejects.toThrow(/another identity/);
    expect(deletes()).toHaveLength(0);
  });
  it('requires stack/instance/disk deletion before credentials and deletes the Gateway reservation last', async () => {
    const approved = await plan();
    await deleteArchivedStack(target, approved);
    await expect(deleteArchivedParameters(target, approved)).rejects.toThrow(/root disk remains/);
    expect(
      mocks.ssm.mock.calls.filter(
        ([command]) => command.constructor.name === 'DeleteParameterCommand',
      ),
    ).toHaveLength(0);
    volumeGone = true;
    await expect(auditArchivedCompute(target, approved)).resolves.toMatchObject({
      rootDiskDeleted: true,
    });
    await deleteArchivedParameters(target, approved);
    const removed = mocks.ssm.mock.calls
      .filter(([command]) => command.constructor.name === 'DeleteParameterCommand')
      .map(([command]) => command.input.Name);
    expect(removed).toEqual([
      '/openclaw/alpha/providers/openrouter-api-key/api-key',
      '/openclaw/alpha/gateway-token',
    ]);
    await deleteArchivedParameters(target, approved);
    expect(parameters).toHaveLength(0);
  });
  it('retains changed/new namespace credentials and propagates failed reads rather than assuming absence', async () => {
    const approved = await plan();
    status = 'DELETE_COMPLETE';
    volumeGone = true;
    parameters[0].Version++;
    await expect(deleteArchivedParameters(target, approved)).rejects.toThrow(/ownership changed/);
    mocks.ec2.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    await expect(auditArchivedCompute(target, approved)).rejects.toThrow(/denied/);
    expect(
      mocks.ssm.mock.calls.filter(
        ([command]) => command.constructor.name === 'DeleteParameterCommand',
      ),
    ).toHaveLength(0);
  });
});
