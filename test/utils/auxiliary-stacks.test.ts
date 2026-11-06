import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
} from '@aws-sdk/client-cloudformation';
const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-cloudformation', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-cloudformation')>()),
  CloudFormationClient: class {
    send = mocks.send;
    destroy = mocks.destroy;
  },
}));
import {
  ensureRecoveryStack,
  recoveryTemplate,
  removeRecoveryAccessStack,
  removeOwnedRolePolicyStack,
} from '../../src/aws/auxiliary-stacks.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const target = {
  ...testTarget,
  region: 'eu-central-1',
  arn: 'arn:aws:iam::123456789012:role/operator',
};
const plan = {
  kind: 'recovery-vault' as const,
  stackName: 'OpenclawVault-primary',
  vaultName: 'primary',
  identity: 'primary',
};
const stackId = `arn:aws:cloudformation:eu-central-1:123456789012:stack/${plan.stackName}/stack-guid`;
const stack = {
  StackId: stackId,
  StackName: plan.stackName,
  StackStatus: 'CREATE_COMPLETE',
  Tags: [
    { Key: 'openclaw-aws:kind', Value: plan.kind },
    { Key: 'openclaw-aws:identity', Value: plan.identity },
  ],
};
const absent = () => Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
beforeEach(() => vi.resetAllMocks());
describe('independent recovery stack lifecycle', () => {
  it('synthesizes only retained recovery resources without bootstrap, AMI or deployment changes', async () => {
    const template = await recoveryTemplate(target, plan);
    expect(JSON.stringify(template)).not.toContain('BootstrapVersion');
    expect(JSON.stringify(template)).not.toContain('AWS::EC2::Instance');
    const resources = Object.values(template.Resources as Record<string, { Type: string }>);
    expect(resources.map((value) => value.Type).sort()).toEqual([
      'AWS::S3::Bucket',
      'AWS::S3::BucketPolicy',
      'AWS::SecretsManager::Secret',
    ]);
  });
  it('creates once, waits for visibility and readiness, and never updates an existing vault', async () => {
    mocks.send
      .mockRejectedValueOnce(absent())
      .mockResolvedValueOnce({ StackId: stackId })
      .mockRejectedValueOnce(absent())
      .mockResolvedValueOnce({ Stacks: [{ ...stack, StackStatus: 'CREATE_IN_PROGRESS' }] })
      .mockResolvedValueOnce({ Stacks: [stack] });
    expect(await ensureRecoveryStack(target, plan, { pollMs: 0 })).toEqual(stack);
    const create = mocks.send.mock.calls.find(
      ([command]) => command instanceof CreateStackCommand,
    )![0];
    expect(create.input).toMatchObject({
      StackName: plan.stackName,
      OnFailure: 'DO_NOTHING',
      Tags: stack.Tags,
    });
    mocks.send.mockResolvedValue({ Stacks: [stack] });
    await ensureRecoveryStack(target, plan);
    expect(
      mocks.send.mock.calls.filter(([command]) => command instanceof CreateStackCommand),
    ).toHaveLength(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...stack, Tags: [] },
    { ...stack, StackId: stackId.replace('123456789012', '999999999999') },
  ])('rejects foreign ownership before any mutation', async (existing) => {
    mocks.send.mockResolvedValue({ Stacks: [existing] });
    await expect(ensureRecoveryStack(target, plan)).rejects.toThrow(/ownership/);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('preserves denied reads and failed creation resources', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    mocks.send.mockRejectedValueOnce(denied);
    await expect(ensureRecoveryStack(target, plan)).rejects.toBe(denied);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.send.mockResolvedValue({ Stacks: [{ ...stack, StackStatus: 'CREATE_FAILED' }] });
    await expect(ensureRecoveryStack(target, plan)).rejects.toThrow(/retained resources/);
    expect(mocks.send.mock.calls.some(([command]) => command instanceof DeleteStackCommand)).toBe(
      false,
    );
  });
  it.each(['recovery-access', 'bedrock-access'] as const)(
    'removes only its owned %s role-policy stack and observes confirmed deletion',
    async (kind) => {
      const access = {
        stackName: 'OpenclawRecovery-source-vault',
        identity: 'source-role-id',
        roleName: 'source-role',
      };
      const identity = {
        StackName: access.stackName,
        StackId: stackId.replace(plan.stackName, access.stackName),
        StackStatus: 'CREATE_COMPLETE',
        Tags: [
          { Key: 'openclaw-aws:kind', Value: kind },
          { Key: 'openclaw-aws:identity', Value: access.identity },
        ],
      };
      mocks.send
        .mockResolvedValueOnce({ Stacks: [identity] })
        .mockResolvedValueOnce({
          TemplateBody: {
            Resources: {
              Policy: {
                Type: 'AWS::IAM::RolePolicy',
                Properties: { RoleName: 'source-role', PolicyName: access.stackName },
              },
            },
          },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Stacks: [{ ...identity, StackStatus: 'DELETE_COMPLETE' }] });
      if (kind === 'recovery-access')
        await removeRecoveryAccessStack(target, access, { pollMs: 0 });
      else await removeOwnedRolePolicyStack(target, { ...access, kind }, { pollMs: 0 });
      const commands = mocks.send.mock.calls.map(([command]) => command);
      expect(commands[0]).toBeInstanceOf(DescribeStacksCommand);
      expect(commands[1]).toBeInstanceOf(GetTemplateCommand);
      expect(commands[1].input.TemplateStage).toBe('Processed');
      expect(commands[2]).toBeInstanceOf(DeleteStackCommand);
      expect(commands[2].input.StackName).toBe(identity.StackId);
    },
  );
  it('refuses to remove a stack containing source compute or a different role policy', async () => {
    const access = {
      stackName: 'OpenclawRecovery-source-vault',
      identity: 'source-role-id',
      roleName: 'source-role',
    };
    const identity = {
      ...stack,
      StackName: access.stackName,
      StackId: stackId.replace(plan.stackName, access.stackName),
      Tags: [
        { Key: 'openclaw-aws:kind', Value: 'recovery-access' },
        { Key: 'openclaw-aws:identity', Value: access.identity },
      ],
    };
    for (const resource of [
      { Type: 'AWS::EC2::Instance' },
      { Type: 'AWS::IAM::RolePolicy', Properties: { RoleName: 'other-role' } },
      {
        Type: 'AWS::IAM::RolePolicy',
        Properties: { RoleName: access.roleName, PolicyName: 'unrelated-policy' },
      },
      {
        Type: 'AWS::IAM::RolePolicy',
        DeletionPolicy: 'Retain',
        Properties: { RoleName: access.roleName, PolicyName: access.stackName },
      },
      {
        Type: 'AWS::IAM::RolePolicy',
        Condition: 'NotActuallyCreated',
        Properties: { RoleName: access.roleName, PolicyName: access.stackName },
      },
    ]) {
      mocks.send
        .mockResolvedValueOnce({ Stacks: [identity] })
        .mockResolvedValueOnce({ TemplateBody: { Resources: { Unexpected: resource } } });
      await expect(removeRecoveryAccessStack(target, access)).rejects.toThrow(
        /unexpected resources/,
      );
    }
    expect(mocks.send.mock.calls.some(([command]) => command instanceof DeleteStackCommand)).toBe(
      false,
    );
  });
});
