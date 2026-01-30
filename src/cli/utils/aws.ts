import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { SSMClient, DescribeInstanceInformationCommand } from '@aws-sdk/client-ssm';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { DeploymentStatus } from '../types/index.js';

export async function getInstanceIdFromStack(
  stackName: string,
  region: string
): Promise<string> {
  const client = new CloudFormationClient({ region });
  const command = new DescribeStacksCommand({ StackName: stackName });
  
  try {
    const response = await client.send(command);
    const outputs = response.Stacks?.[0]?.Outputs || [];
    
    const instanceIdOutput = outputs.find(o => o.OutputKey === 'InstanceId');
    if (!instanceIdOutput?.OutputValue) {
      throw new Error('Instance ID not found in stack outputs');
    }
    
    return instanceIdOutput.OutputValue;
  } catch (error) {
    if (error instanceof Error && error.name === 'ValidationError') {
      throw new Error(`Stack '${stackName}' not found in region '${region}'`);
    }
    throw error;
  }
}

export async function checkSSMStatus(
  instanceId: string,
  region: string
): Promise<boolean> {
  const client = new SSMClient({ region });
  const command = new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
  });
  
  try {
    const response = await client.send(command);
    const instance = response.InstanceInformationList?.[0];
    return instance?.PingStatus === 'Online';
  } catch {
    return false;
  }
}

export async function waitForSSM(
  instanceId: string,
  region: string,
  maxWaitTime: number = 300000, // 5 minutes
  pollInterval: number = 5000 // 5 seconds
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitTime) {
    const isReady = await checkSSMStatus(instanceId, region);
    if (isReady) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  return false;
}

export async function getStackStatus(
  stackName: string,
  region: string
): Promise<DeploymentStatus> {
  const client = new CloudFormationClient({ region });
  const command = new DescribeStacksCommand({ StackName: stackName });
  
  try {
    const response = await client.send(command);
    const stack = response.Stacks?.[0];
    
    if (!stack) {
      throw new Error(`Stack '${stackName}' not found`);
    }

    const status: DeploymentStatus = {
      stackName: stack.StackName || stackName,
      stackStatus: stack.StackStatus || 'UNKNOWN',
    };

    // Try to get instance ID
    try {
      const instanceId = await getInstanceIdFromStack(stackName, region);
      status.instanceId = instanceId;

      // Get instance status
      const ec2Client = new EC2Client({ region });
      const instanceResponse = await ec2Client.send(
        new DescribeInstancesCommand({
          InstanceIds: [instanceId]
        })
      );

      const instance = instanceResponse.Reservations?.[0]?.Instances?.[0];
      if (instance) {
        status.instanceStatus = instance.State?.Name || 'unknown';
      }

      // Get SSM status
      const ssmReady = await checkSSMStatus(instanceId, region);
      status.ssmStatus = ssmReady ? 'ready' : 'not-ready';
    } catch {
      // Instance might not be created yet
    }

    return status;
  } catch (error) {
    if (error instanceof Error && error.name === 'ValidationError') {
      throw new Error(`Stack '${stackName}' not found in region '${region}'`);
    }
    throw error;
  }
}

export async function getStackOutputs(
  stackName: string,
  region: string
): Promise<Record<string, string>> {
  const client = new CloudFormationClient({ region });
  const command = new DescribeStacksCommand({ StackName: stackName });
  
  try {
    const response = await client.send(command);
    const outputs = response.Stacks?.[0]?.Outputs || [];
    
    const result: Record<string, string> = {};
    outputs.forEach(output => {
      if (output.OutputKey && output.OutputValue) {
        result[output.OutputKey] = output.OutputValue;
      }
    });
    
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'ValidationError') {
      throw new Error(`Stack '${stackName}' not found in region '${region}'`);
    }
    throw error;
  }
}
