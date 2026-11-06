import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { awsClientConfig, type AwsTarget } from './target.js';
import type { BackupCaptureJob } from '../openclaw/backup-contract.js';

export type RecoveryPresence =
  | { kind: 'gone'; stack: 'missing' | 'deleted'; archivedInstance: 'missing' | 'terminated' }
  | { kind: 'retained-host'; instanceId: string; state: string }
  | {
      kind: 'live';
      stackId: string;
      stackName: string;
      instanceId: string;
      state: string;
      changedSinceBackup: boolean;
    };
const instancePattern = /^i-[a-f0-9]{8,17}$/;

/** Resolve the immutable source, including retained/replaced instances, without local config. */
export async function inspectRecoveryPresence(
  target: AwsTarget,
  source: BackupCaptureJob['source'],
): Promise<RecoveryPresence> {
  const match =
    /^arn:(aws(?:-[a-z-]+)?):cloudformation:([a-z0-9-]+):(\d{12}):stack\/([A-Za-z][A-Za-z0-9-]*)\/[A-Za-z0-9-]+$/.exec(
      source.stackId,
    );
  if (
    !match ||
    match[1] !== target.arn.split(':')[1] ||
    match[2] !== target.region ||
    match[3] !== target.account ||
    source.account !== target.account ||
    source.region !== target.region ||
    !instancePattern.test(source.instanceId)
  )
    throw new Error(
      'Source recovery identity does not match the selected account and vault region',
    );
  const cfn = new CloudFormationClient(awsClientConfig(target));
  const ec2 = new EC2Client(awsClientConfig(target));
  const signal = AbortSignal.timeout(60000);
  const instanceState = async (id: string): Promise<string> => {
    try {
      const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }), {
        abortSignal: signal,
      });
      const reservation = result.Reservations?.[0];
      const instance = reservation?.Instances?.[0];
      if (
        result.Reservations?.length !== 1 ||
        reservation?.OwnerId !== target.account ||
        reservation.Instances?.length !== 1 ||
        instance?.InstanceId !== id ||
        !['pending', 'running', 'shutting-down', 'terminated', 'stopping', 'stopped'].includes(
          instance.State?.Name ?? '',
        )
      )
        throw new Error('AWS returned an incomplete source instance identity or state');
      return instance.State!.Name!;
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidInstanceID.NotFound') return 'missing';
      throw error;
    }
  };
  try {
    let stack;
    try {
      const result = await cfn.send(new DescribeStacksCommand({ StackName: source.stackId }), {
        abortSignal: signal,
      });
      if (
        result.Stacks?.length !== 1 ||
        result.Stacks[0].StackId !== source.stackId ||
        result.Stacks[0].StackName !== match[4] ||
        !result.Stacks[0].StackStatus
      )
        throw new Error('AWS returned an inconsistent immutable source stack identity');
      stack = result.Stacks[0];
    } catch (error) {
      if (!(
        error instanceof Error &&
        error.name === 'ValidationError' &&
        error.message.includes(source.stackId) &&
        /does not exist/.test(error.message)
      ))
        throw error;
    }
    const archivedState = await instanceState(source.instanceId);
    const archivedGone = archivedState === 'missing' || archivedState === 'terminated';
    if (!stack || stack.StackStatus === 'DELETE_COMPLETE') {
      if (!archivedGone)
        return { kind: 'retained-host', instanceId: source.instanceId, state: archivedState };
      return {
        kind: 'gone',
        stack: stack ? 'deleted' : 'missing',
        archivedInstance: archivedState as 'missing' | 'terminated',
      };
    }
    if (
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
        stack.StackStatus!,
      )
    )
      throw new Error(
        'The source stack is changing or incomplete; inspect it before restoring its messaging identity',
      );
    const ids = new Set<string>();
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await cfn.send(
        new ListStackResourcesCommand({ StackName: source.stackId, NextToken: token }),
        { abortSignal: signal },
      );
      if (!Array.isArray(page.StackResourceSummaries))
        throw new Error('Source host ownership inventory is incomplete');
      for (const resource of page.StackResourceSummaries) {
        if (
          resource.ResourceType !== 'AWS::EC2::Instance' ||
          resource.ResourceStatus === 'DELETE_COMPLETE'
        )
          continue;
        if (!resource.PhysicalResourceId || !instancePattern.test(resource.PhysicalResourceId))
          throw new Error('Source host inventory contains an invalid instance identity');
        ids.add(resource.PhysicalResourceId);
      }
      token = page.NextToken;
      if (token && seen.has(token)) throw new Error('Source host inventory pagination repeated');
      if (token) seen.add(token);
    } while (token);
    if (ids.size !== 1)
      throw new Error('A source takeover requires exactly one identifiable hosting instance');
    const currentId = [...ids][0];
    if (currentId !== source.instanceId && !archivedGone)
      return { kind: 'retained-host', instanceId: source.instanceId, state: archivedState };
    const state = currentId === source.instanceId ? archivedState : await instanceState(currentId);
    return {
      kind: 'live',
      stackId: source.stackId,
      stackName: match[4],
      instanceId: currentId,
      state,
      changedSinceBackup: currentId !== source.instanceId,
    };
  } finally {
    cfn.destroy();
    ec2.destroy();
  }
}
