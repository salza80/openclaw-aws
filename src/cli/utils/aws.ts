import { openclawJson } from '../../openclaw/commands.js';
import { awsRegion, type AwsLocation } from '../../aws/target.js';
import {
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { DescribeInstanceInformationCommand } from '@aws-sdk/client-ssm';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { DeploymentStatus } from '../types/index.js';
import { createCloudFormationClient, createEc2Client, createSsmClient } from './aws-clients.js';
import { StackNotFoundError, withRetry, isRetryableError } from './errors.js';

function isMissingStackResponse(error: unknown, stackName: string): boolean {
  return (
    error instanceof Error &&
    error.name === 'ValidationError' &&
    error.message === `Stack with id ${stackName} does not exist`
  );
}

export async function getInstanceIdFromStack(
  stackName: string,
  region: AwsLocation,
): Promise<string> {
  const client = createCloudFormationClient(region);
  const command = new DescribeStacksCommand({ StackName: stackName });

  try {
    const response = await client.send(command);
    const outputs = response.Stacks?.[0]?.Outputs || [];

    const instanceIdOutput = outputs.find((o) => o.OutputKey === 'InstanceId');
    if (instanceIdOutput?.OutputValue) return instanceIdOutput.OutputValue;

    // Failed creations may retain the instance before CloudFormation publishes outputs.
    const resources = await client.send(
      new DescribeStackResourcesCommand({ StackName: stackName }),
    );
    const instanceIds = (resources.StackResources ?? [])
      .filter(
        (resource) =>
          resource.ResourceType === 'AWS::EC2::Instance' &&
          resource.ResourceStatus !== 'DELETE_COMPLETE',
      )
      .map((resource) => resource.PhysicalResourceId)
      .filter(
        (id): id is string => typeof id === 'string' && /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id),
      );
    if (instanceIds.length === 0) {
      throw new Error(
        `Instance ID not found in stack '${stackName}' outputs or nondeleted EC2 resources`,
      );
    }
    if (instanceIds.length !== 1) {
      throw new Error(
        `Multiple nondeleted EC2 instances found in stack '${stackName}'; cannot select an instance safely`,
      );
    }
    return instanceIds[0];
  } catch (error) {
    if (isMissingStackResponse(error, stackName)) {
      throw new StackNotFoundError(stackName, awsRegion(region), { cause: error });
    }
    throw error;
  } finally {
    client.destroy();
  }
}

export async function resolveInstanceId(stackName: string, region: AwsLocation): Promise<string> {
  return withRetry(() => getInstanceIdFromStack(stackName, region), {
    maxAttempts: 2,
    operationName: 'get instance ID',
    shouldRetry: isRetryableError,
  });
}

export async function checkSSMStatus(instanceId: string, region: AwsLocation): Promise<boolean> {
  const client = createSsmClient(region);
  const command = new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
  });

  try {
    const response = await client.send(command);
    const instance = response.InstanceInformationList?.[0];

    // Only return true if explicitly Online
    // ConnectionLost, Inactive, or missing instance all return false
    return instance?.PingStatus === 'Online';
  } finally {
    client.destroy();
  }
}

export async function getSSMStatus(
  instanceId: string,
  region: AwsLocation,
): Promise<{ status: string; lastPing?: string }> {
  const client = createSsmClient(region);
  const command = new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
  });

  try {
    const response = await client.send(command);
    const instance = response.InstanceInformationList?.[0];

    if (!instance) {
      return { status: 'not-registered' };
    }

    return {
      status: instance.PingStatus || 'unknown',
      lastPing: instance.LastPingDateTime?.toISOString(),
    };
  } finally {
    client.destroy();
  }
}

export async function checkGatewayStatus(
  instanceId: string,
  region: AwsLocation,
): Promise<{ running: boolean; error?: string }> {
  try {
    const health = await openclawJson(instanceId, region, ['health'], { executionSeconds: 60 });
    const running =
      typeof health === 'object' && health !== null && 'ok' in health && health.ok === true;
    return { running, error: running ? undefined : 'Native Gateway health did not report ok' };
  } catch (error) {
    return {
      running: false,
      error: error instanceof Error ? error.message : 'Health check failed',
    };
  }
}

export async function waitForSSM(
  instanceId: string,
  region: AwsLocation,
  maxWaitTime: number = 300000, // 5 minutes
  pollInterval: number = 5000, // 5 seconds
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const isReady = await checkSSMStatus(instanceId, region);
    if (isReady) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

export async function getStackStatus(
  stackName: string,
  region: AwsLocation,
): Promise<DeploymentStatus> {
  const client = createCloudFormationClient(region);
  const command = new DescribeStacksCommand({ StackName: stackName });

  try {
    const response = await client.send(command);
    const stack = response.Stacks?.[0];

    if (!stack) {
      throw new StackNotFoundError(stackName, awsRegion(region));
    }

    const status: DeploymentStatus = {
      stackId: stack.StackId,
      stackName: stack.StackName || stackName,
      stackStatus: stack.StackStatus || 'UNKNOWN',
    };

    // Try to get instance ID
    try {
      const instanceId = await getInstanceIdFromStack(stackName, region);
      status.instanceId = instanceId;

      // Get instance status
      const ec2Client = createEc2Client(region);
      try {
        const instanceResponse = await ec2Client.send(
          new DescribeInstancesCommand({
            InstanceIds: [instanceId],
          }),
        );

        const instance = instanceResponse.Reservations?.[0]?.Instances?.[0];
        if (instance) {
          status.instanceStatus = instance.State?.Name || 'unknown';
        }
      } finally {
        ec2Client.destroy();
      }

      // Get SSM status
      const ssmReady = await checkSSMStatus(instanceId, region);
      status.ssmStatus = ssmReady ? 'ready' : 'not-ready';
    } catch {
      // Instance might not be created yet
    }

    return status;
  } catch (error) {
    if (isMissingStackResponse(error, stackName)) {
      throw new StackNotFoundError(stackName, awsRegion(region), { cause: error });
    }
    throw error;
  } finally {
    client.destroy();
  }
}

export async function getStackOutputs(
  stackName: string,
  region: AwsLocation,
): Promise<Record<string, string>> {
  const client = createCloudFormationClient(region);
  const command = new DescribeStacksCommand({ StackName: stackName });

  try {
    const response = await client.send(command);
    const outputs = response.Stacks?.[0]?.Outputs || [];

    const result: Record<string, string> = {};
    outputs.forEach((output) => {
      if (output.OutputKey && output.OutputValue) {
        result[output.OutputKey] = output.OutputValue;
      }
    });

    return result;
  } catch (error) {
    if (isMissingStackResponse(error, stackName)) {
      throw new StackNotFoundError(stackName, awsRegion(region), { cause: error });
    }
    throw error;
  } finally {
    client.destroy();
  }
}
