import { createHash } from 'node:crypto';
import {
  CloudFormationClient,
  ListStackResourcesCommand,
  type StackResourceSummary,
} from '@aws-sdk/client-cloudformation';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  GetInstanceProfileCommand,
  GetRoleCommand,
  IAMClient,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import type { CommandContext } from '../cli/utils/context.js';
import { getStackStatus } from '../cli/utils/aws.js';
import { assertDeploymentTarget } from '../operations/state.js';
import { awsClientConfig, type AwsTarget } from './target.js';
import { removeRecoveryAccessStack } from './auxiliary-stacks.js';
import { partition } from './vault-security.js';

export interface RecoverySource {
  stackId: string;
  stackName: string;
  instanceId: string;
  role: { name: string; arn: string; id: string };
  profile: { arn: string; id: string };
  instance: {
    type: string;
    imageId: string;
    subnetId: string;
    vpcId: string;
    architecture: string;
  };
  resources: { type: string; id: string }[];
}
export const sourceHash = (stackId: string) =>
  createHash('sha256').update(stackId).digest('hex').slice(0, 16);
export const sourceAccessIdentity = (stackId: string, roleId: string) =>
  createHash('sha256')
    .update(JSON.stringify([stackId, roleId]))
    .digest('hex');
async function sourceResources(
  target: AwsTarget,
  stackId: string,
): Promise<StackResourceSummary[]> {
  const client = new CloudFormationClient(awsClientConfig(target));
  const signal = AbortSignal.timeout(30000);
  const resources: StackResourceSummary[] = [];
  const seen = new Set<string>();
  try {
    let next: string | undefined;
    do {
      const result = await client.send(
        new ListStackResourcesCommand({ StackName: stackId, NextToken: next }),
        { abortSignal: signal },
      );
      if (!result.StackResourceSummaries)
        throw new Error('Source stack resource inventory is incomplete');
      resources.push(...result.StackResourceSummaries);
      next = result.NextToken;
      if (next && seen.has(next)) throw new Error('Source stack resource pagination repeated');
      if (next) seen.add(next);
    } while (next);
    return resources;
  } finally {
    client.destroy();
  }
}
export async function inspectRecoverySource(ctx: CommandContext): Promise<RecoverySource> {
  const status = await getStackStatus(ctx.config.stack.name, ctx.target);
  assertDeploymentTarget(ctx, status);
  if (
    status.stackName !== ctx.config.stack.name ||
    !status.stackId?.startsWith(
      `arn:${partition(ctx.target)}:cloudformation:${ctx.target.region}:${ctx.target.account}:stack/${ctx.config.stack.name}/`,
    )
  )
    throw new Error('Source stack identity does not match the selected AWS target');
  if (
    !status.stackId ||
    !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(status.stackStatus)
  )
    throw new Error('Backup requires a stable source stack identity');
  const resources = await sourceResources(ctx.target, status.stackId);
  const instances = resources.filter(
    (resource) =>
      resource.ResourceType === 'AWS::EC2::Instance' &&
      resource.ResourceStatus !== 'DELETE_COMPLETE',
  );
  if (
    instances.length !== 1 ||
    !instances[0].PhysicalResourceId ||
    (status.instanceId && status.instanceId !== instances[0].PhysicalResourceId)
  )
    throw new Error('Source stack must own exactly one identifiable hosting instance');
  const instanceId = instances[0].PhysicalResourceId;
  const ec2 = new EC2Client(awsClientConfig(ctx.target));
  const iam = new IAMClient(awsClientConfig(ctx.target));
  const signal = AbortSignal.timeout(30000);
  try {
    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }), {
      abortSignal: signal,
    });
    const reservations = described.Reservations;
    const host = reservations?.[0]?.Instances?.[0];
    if (
      reservations?.length !== 1 ||
      reservations[0].OwnerId !== ctx.target.account ||
      reservations[0].Instances?.length !== 1 ||
      host?.InstanceId !== instanceId ||
      host.State?.Name !== 'running' ||
      !host.IamInstanceProfile?.Arn ||
      !host.InstanceType ||
      !host.ImageId ||
      !host.SubnetId ||
      !host.VpcId ||
      !host.Architecture
    )
      throw new Error(
        'Source instance is not a running, fully identified host in the selected account',
      );
    const profileArn = host.IamInstanceProfile.Arn;
    if (
      !profileArn.startsWith(
        `arn:${partition(ctx.target)}:iam::${ctx.target.account}:instance-profile/`,
      )
    )
      throw new Error('Source instance profile belongs to another AWS identity');
    const response = await iam.send(
      new GetInstanceProfileCommand({ InstanceProfileName: profileArn.split('/').at(-1) }),
      { abortSignal: signal },
    );
    const profile = response.InstanceProfile;
    if (
      profile?.Arn !== profileArn ||
      !profile.InstanceProfileId ||
      profile.InstanceProfileId !== host.IamInstanceProfile.Id ||
      profile.Roles?.length !== 1 ||
      !resources.some(
        (resource) =>
          resource.ResourceType === 'AWS::IAM::InstanceProfile' &&
          resource.PhysicalResourceId === profile.InstanceProfileName,
      )
    )
      throw new Error('Source stack does not own the instance profile');
    const attachedRole = profile.Roles[0];
    if (
      !attachedRole.RoleName ||
      !resources.some(
        (resource) =>
          resource.ResourceType === 'AWS::IAM::Role' &&
          resource.PhysicalResourceId === attachedRole.RoleName,
      )
    )
      throw new Error('Source stack does not own the hosting role');
    const { Role: role } = await iam.send(new GetRoleCommand({ RoleName: attachedRole.RoleName }), {
      abortSignal: signal,
    });
    if (
      !role?.Arn?.startsWith(`arn:${partition(ctx.target)}:iam::${ctx.target.account}:role/`) ||
      role.Arn !== attachedRole.Arn ||
      !role.RoleId ||
      role.RoleId !== attachedRole.RoleId ||
      role.RoleName !== attachedRole.RoleName
    )
      throw new Error('Source hosting role identity changed');
    const sharing = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: 'iam-instance-profile.arn', Values: [profileArn] },
          { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
        ],
      }),
      { abortSignal: signal },
    );
    const sharingIds = sharing.Reservations?.flatMap(
      (reservation) => reservation.Instances ?? [],
    ).map((instance) => instance.InstanceId);
    if (sharingIds?.length !== 1 || sharingIds[0] !== instanceId)
      throw new Error(
        'Hosting instance profile is shared or its isolation could not be established',
      );
    return {
      stackId: status.stackId,
      stackName: status.stackName,
      instanceId,
      role: { name: role.RoleName, arn: role.Arn, id: role.RoleId },
      profile: { arn: profileArn, id: profile.InstanceProfileId },
      instance: {
        type: host.InstanceType,
        imageId: host.ImageId,
        subnetId: host.SubnetId,
        vpcId: host.VpcId,
        architecture: host.Architecture,
      },
      resources: resources.flatMap((resource) =>
        resource.ResourceType && resource.PhysicalResourceId
          ? [{ type: resource.ResourceType, id: resource.PhysicalResourceId }]
          : [],
      ),
    };
  } finally {
    ec2.destroy();
    iam.destroy();
  }
}

/** Run before deleting a source role, including retries after partial source teardown. */
export async function removeSourceRecoveryAccess(
  target: AwsTarget,
  stackId: string,
): Promise<void> {
  const resources = await sourceResources(target, stackId);
  const iam = new IAMClient(awsClientConfig(target));
  try {
    for (const resource of resources.filter(
      (entry) => entry.ResourceType === 'AWS::IAM::Role' && entry.PhysicalResourceId,
    )) {
      const name = resource.PhysicalResourceId!;
      let role;
      try {
        role = (
          await iam.send(new GetRoleCommand({ RoleName: name }), {
            abortSignal: AbortSignal.timeout(30000),
          })
        ).Role;
      } catch (error) {
        if (
          error instanceof Error &&
          ['NoSuchEntity', 'NoSuchEntityException'].includes(error.name)
        )
          continue;
        throw error;
      }
      if (
        !role?.RoleId ||
        role.RoleName !== name ||
        !role.Arn?.startsWith(`arn:${partition(target)}:iam::${target.account}:role/`)
      )
        throw new Error('Could not confirm source role identity before policy cleanup');
      let marker: string | undefined;
      const seen = new Set<string>();
      while (true) {
        const policies = await iam.send(
          new ListRolePoliciesCommand({ RoleName: name, Marker: marker }),
          { abortSignal: AbortSignal.timeout(30000) },
        );
        if (!policies.PolicyNames) throw new Error('Hosting role policy inventory is incomplete');
        for (const policy of policies.PolicyNames.filter((entry) =>
          entry.startsWith(`OpenclawRecovery-${sourceHash(stackId)}-`),
        ))
          await removeRecoveryAccessStack(target, {
            stackName: policy,
            identity: sourceAccessIdentity(stackId, role.RoleId),
            roleName: name,
          });
        if (!policies.IsTruncated) break;
        marker = policies.Marker;
        if (!marker || seen.has(marker))
          throw new Error('Hosting role policy pagination is invalid');
        seen.add(marker);
      }
    }
  } finally {
    iam.destroy();
  }
}
