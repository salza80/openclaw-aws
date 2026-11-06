import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  DeleteStackCommand,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { IAMClient, GetRoleCommand, GetInstanceProfileCommand } from '@aws-sdk/client-iam';
import { SSMClient, DescribeParametersCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { awsClientConfig, type AwsTarget } from './target.js';
import {
  removeSourceRecoveryAccess,
  sourceResources,
  type RecoverySource,
} from './recovery-source.js';
import { isApiKeyProvider } from '../openclaw/connections.js';

export interface ArchiveParameter {
  name: string;
  arn: string;
  version: number;
  modifiedAt: string;
}
export interface ArchiveDeletionPlan {
  deploymentName: string;
  source: RecoverySource;
  templateDigest: string;
  volumeId: string;
  parameters: ArchiveParameter[];
}
const resourceTypes = new Set([
  'AWS::CDK::Metadata',
  'AWS::EC2::Instance',
  'AWS::EC2::SecurityGroup',
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::Route',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::IAM::InstanceProfile',
  'AWS::Logs::LogGroup',
]);
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => [key, ordered(value)]),
        )
      : value;
async function template(target: AwsTarget, source: RecoverySource) {
  const client = new CloudFormationClient(awsClientConfig(target));
  try {
    const result = await client.send(
      new GetTemplateCommand({ StackName: source.stackId, TemplateStage: 'Processed' }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    const body =
      typeof result.TemplateBody === 'string'
        ? JSON.parse(result.TemplateBody)
        : result.TemplateBody;
    if (!body || typeof body !== 'object' || !body.Resources || typeof body.Resources !== 'object')
      throw new Error('Archive source template is unavailable');
    for (const resource of Object.values(body.Resources) as {
      Type?: string;
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
    }[]) {
      if (
        !resourceTypes.has(resource.Type ?? '') ||
        (resource.DeletionPolicy && resource.DeletionPolicy !== 'Delete') ||
        (resource.UpdateReplacePolicy && resource.UpdateReplacePolicy !== 'Delete')
      )
        throw new Error(
          'Archive source owns unsupported or retained resources; no teardown was authorized',
        );
    }
    return createHash('sha256')
      .update(JSON.stringify(ordered(body)))
      .digest('hex');
  } finally {
    client.destroy();
  }
}
export async function archiveParameters(
  target: AwsTarget,
  deploymentName: string,
): Promise<ArchiveParameter[]> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(deploymentName))
    throw new Error('Invalid archive credential namespace');
  const client = new SSMClient(awsClientConfig(target));
  const prefix = `/openclaw/${deploymentName}/`;
  const result: ArchiveParameter[] = [];
  const tokens = new Set<string>();
  try {
    let next: string | undefined;
    do {
      const page = await client.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: 'Name', Option: 'BeginsWith', Values: [prefix] }],
          NextToken: next,
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      for (const item of page.Parameters ?? []) {
        const provider = item.Name?.slice(prefix.length).match(
          /^providers\/([a-z0-9-]+)\/api-key$/,
        )?.[1];
        if (
          !item.Name ||
          (item.Name !== prefix + 'gateway-token' && (!provider || !isApiKeyProvider(provider))) ||
          item.Type !== 'SecureString' ||
          !item.ARN ||
          item.ARN !==
            `arn:${target.arn.split(':')[1]}:ssm:${target.region}:${target.account}:parameter${item.Name}` ||
          !item.Version ||
          !item.LastModifiedDate ||
          result.some((p) => p.name === item.Name)
        )
          throw new Error('Archive credential namespace has unsupported or ambiguous ownership');
        result.push({
          name: item.Name,
          arn: item.ARN,
          version: item.Version,
          modifiedAt: item.LastModifiedDate.toISOString(),
        });
      }
      if (result.length > 100)
        throw new Error('Archive credential namespace exceeds its supported bound');
      next = page.NextToken;
      if (next && tokens.has(next)) throw new Error('Archive credential inventory repeated a page');
      if (next) tokens.add(next);
    } while (next);
    return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } finally {
    client.destroy();
  }
}
export async function planArchiveDeletion(
  target: AwsTarget,
  deploymentName: string,
  source: RecoverySource,
): Promise<ArchiveDeletionPlan> {
  const ec2 = new EC2Client(awsClientConfig(target));
  try {
    const host = (
      await ec2.send(new DescribeInstancesCommand({ InstanceIds: [source.instanceId] }), {
        abortSignal: AbortSignal.timeout(30000),
      })
    ).Reservations?.[0]?.Instances?.[0];
    const disks = host?.BlockDeviceMappings;
    const volumeId = disks?.[0]?.Ebs?.VolumeId;
    if (
      host?.InstanceId !== source.instanceId ||
      host.State?.Name !== 'running' ||
      host.IamInstanceProfile?.Arn !== source.profile.arn ||
      disks?.length !== 1 ||
      disks[0].DeviceName !== host.RootDeviceName ||
      disks[0].Ebs?.DeleteOnTermination !== true ||
      !volumeId
    )
      throw new Error(
        'Archive requires the owned running instance and its single auto-deleted root disk',
      );
    const disk = (
      await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }), {
        abortSignal: AbortSignal.timeout(30000),
      })
    ).Volumes?.[0];
    if (
      disk?.VolumeId !== volumeId ||
      disk.Encrypted !== true ||
      disk.Attachments?.length !== 1 ||
      disk.Attachments[0].InstanceId !== source.instanceId
    )
      throw new Error('Archive root disk ownership or encryption is unconfirmed');
    const templateDigest = await template(target, source);
    const parameters = await archiveParameters(target, deploymentName);
    if (!parameters.some((p) => p.name === `/openclaw/${deploymentName}/gateway-token`))
      throw new Error('Archive source has no reserved Gateway credential namespace');
    return { deploymentName, source, templateDigest, volumeId, parameters };
  } finally {
    ec2.destroy();
  }
}
export async function assertArchiveDeletionCurrent(target: AwsTarget, plan: ArchiveDeletionPlan) {
  const current = await planArchiveDeletion(target, plan.deploymentName, plan.source);
  if (
    current.volumeId !== plan.volumeId ||
    current.templateDigest !== plan.templateDigest ||
    !isDeepStrictEqual(current.parameters, plan.parameters)
  )
    throw new Error(
      'Archive infrastructure or credential ownership changed; source teardown was refused',
    );
}
async function roleIdentity(target: AwsTarget, source: RecoverySource) {
  const client = new IAMClient(awsClientConfig(target));
  try {
    try {
      const role = (
        await client.send(new GetRoleCommand({ RoleName: source.role.name }), {
          abortSignal: AbortSignal.timeout(30000),
        })
      ).Role;
      if (role?.RoleId !== source.role.id)
        throw new Error('Archive role name now belongs to another identity');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['NoSuchEntity', 'NoSuchEntityException'].includes(error.name)
      )
        throw error;
    }
    try {
      const profile = (
        await client.send(
          new GetInstanceProfileCommand({
            InstanceProfileName: source.profile.arn.split('/').at(-1)!,
          }),
          { abortSignal: AbortSignal.timeout(30000) },
        )
      ).InstanceProfile;
      if (profile?.InstanceProfileId !== source.profile.id)
        throw new Error('Archive instance profile now belongs to another identity');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['NoSuchEntity', 'NoSuchEntityException'].includes(error.name)
      )
        throw error;
    }
  } finally {
    client.destroy();
  }
}
/** Only the archive operation calls this, after a committed verified recovery
 * point, a fresh native teardown certificate, and independent remote intent.
 */
export async function deleteArchivedStack(target: AwsTarget, plan: ArchiveDeletionPlan) {
  const source = plan.source;
  if (
    !source.stackId.startsWith(
      `arn:${target.arn.split(':')[1]}:cloudformation:${target.region}:${target.account}:stack/${source.stackName}/`,
    )
  )
    throw new Error('Archive source belongs to another AWS target');
  const client = new CloudFormationClient(awsClientConfig(target));
  try {
    const stack = (
      await client.send(new DescribeStacksCommand({ StackName: source.stackId }), {
        abortSignal: AbortSignal.timeout(30000),
      })
    ).Stacks?.[0];
    if (stack?.StackId !== source.stackId)
      throw new Error('Archive source stack identity is unconfirmed');
    if (stack.StackStatus === 'DELETE_COMPLETE') return;
    if (
      ![
        'CREATE_COMPLETE',
        'UPDATE_COMPLETE',
        'UPDATE_ROLLBACK_COMPLETE',
        'DELETE_FAILED',
        'DELETE_IN_PROGRESS',
      ].includes(stack.StackStatus ?? '')
    )
      throw new Error('Archive source is changing; inspect it before teardown');
    if (stack.StackStatus !== 'DELETE_IN_PROGRESS') {
      if ((await template(target, source)) !== plan.templateDigest)
        throw new Error('Archive source template changed before teardown');
      const resources = await sourceResources(target, source.stackId);
      if (
        !resources ||
        resources.some(
          (r) =>
            r.ResourceType === 'AWS::EC2::Instance' && r.PhysicalResourceId !== source.instanceId,
        )
      )
        throw new Error('Archive source instance was replaced');
      await roleIdentity(target, source);
      await removeSourceRecoveryAccess(target, source.stackId);
      await client.send(new DeleteStackCommand({ StackName: source.stackId }), {
        abortSignal: AbortSignal.timeout(30000),
      });
    }
    const waited = await waitUntilStackDeleteComplete(
      { client, maxWaitTime: 1500 },
      { StackName: source.stackId },
    );
    if (waited.state !== 'SUCCESS')
      throw new Error(
        'Archive teardown is incomplete; backup and source credentials were retained',
      );
  } finally {
    client.destroy();
  }
}
export async function auditArchivedCompute(target: AwsTarget, plan: ArchiveDeletionPlan) {
  const cf = new CloudFormationClient(awsClientConfig(target)),
    ec2 = new EC2Client(awsClientConfig(target));
  try {
    const stack = (
      await cf.send(new DescribeStacksCommand({ StackName: plan.source.stackId }), {
        abortSignal: AbortSignal.timeout(30000),
      })
    ).Stacks?.[0];
    if (stack?.StackId !== plan.source.stackId || stack.StackStatus !== 'DELETE_COMPLETE')
      throw new Error('Archive stack deletion has not been confirmed');
    let terminated = false;
    try {
      const host = (
        await ec2.send(new DescribeInstancesCommand({ InstanceIds: [plan.source.instanceId] }), {
          abortSignal: AbortSignal.timeout(30000),
        })
      ).Reservations?.[0]?.Instances?.[0];
      terminated = host?.InstanceId === plan.source.instanceId && host.State?.Name === 'terminated';
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'InvalidInstanceID.NotFound') throw error;
      terminated = true;
    }
    if (!terminated) throw new Error('Archive instance termination is unconfirmed');
    try {
      await ec2.send(new DescribeVolumesCommand({ VolumeIds: [plan.volumeId] }), {
        abortSignal: AbortSignal.timeout(30000),
      });
      throw new Error('Archive root disk remains; cleanup is incomplete');
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'InvalidVolume.NotFound') throw error;
    }
    return { stackDeleted: true, instanceTerminated: true, rootDiskDeleted: true };
  } finally {
    cf.destroy();
    ec2.destroy();
  }
}
export async function deleteArchivedParameters(target: AwsTarget, plan: ArchiveDeletionPlan) {
  await auditArchivedCompute(target, plan);
  const current = await archiveParameters(target, plan.deploymentName);
  if (current.some((p) => !plan.parameters.some((saved) => isDeepStrictEqual(saved, p))))
    throw new Error('Source credential ownership changed; nothing was deleted');
  const gateway = `/openclaw/${plan.deploymentName}/gateway-token`;
  if (current.some((p) => p.name !== gateway) && !current.some((p) => p.name === gateway))
    throw new Error('Source credential namespace reservation is missing; nothing was deleted');
  const client = new SSMClient(awsClientConfig(target));
  try {
    for (const item of [
      ...current.filter((p) => p.name !== gateway),
      ...current.filter((p) => p.name === gateway),
    ]) {
      try {
        await client.send(new DeleteParameterCommand({ Name: item.name }), {
          abortSignal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'ParameterNotFound') throw error;
      }
    }
  } finally {
    client.destroy();
  }
}
