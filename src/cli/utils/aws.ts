import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeInstanceInformationCommand, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { DeploymentStatus } from '../types/index.js';
import { createCloudFormationClient, createEc2Client, createSsmClient } from './aws-clients.js';
import { AWSError, withRetry } from './errors.js';

export async function getInstanceIdFromStack(
  stackName: string,
  region: string
): Promise<string> {
  const client = createCloudFormationClient(region);
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
  } finally {
    client.destroy();
  }
}

export async function resolveInstanceId(
  stackName: string,
  region: string
): Promise<string> {
  try {
    return await withRetry(
      () => getInstanceIdFromStack(stackName, region),
      { maxAttempts: 2, operationName: 'get instance ID' }
    );
  } catch {
    throw new AWSError('Could not find instance', [
      'Run: openclaw-aws deploy (to create instance)',
      'Run: openclaw-aws status (to check deployment)'
    ]);
  }
}

export async function checkSSMStatus(
  instanceId: string,
  region: string
): Promise<boolean> {
  const client = createSsmClient(region);
  const command = new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
  });
  
  try {
    const response = await client.send(command);
    const instance = response.InstanceInformationList?.[0];
    
    // Only return true if explicitly Online
    // ConnectionLost, Inactive, or missing instance all return false
    return instance?.PingStatus === 'Online';
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

export async function getSSMStatus(
  instanceId: string,
  region: string
): Promise<{ status: string; lastPing?: string }> {
  const client = createSsmClient(region);
  const command = new DescribeInstanceInformationCommand({
    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
  });
  
  try {
    const response = await client.send(command);
    const instance = response.InstanceInformationList?.[0];
    
    if (!instance) {
      return { status: 'not-registered' };
    }
    
    return {
      status: instance.PingStatus || 'unknown',
      lastPing: instance.LastPingDateTime?.toISOString()
    };
  } catch {
    return { status: 'error' };
  } finally {
    client.destroy();
  }
}

export async function checkGatewayStatus(
  instanceId: string,
  region: string
): Promise<{ running: boolean; error?: string }> {
  const client = createSsmClient(region);
  
  try {
    // Send command to check if openclaw gateway service is running
    const sendCommand = new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands: [
          'sudo -u ubuntu bash -c "export XDG_RUNTIME_DIR=/run/user/1000; export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; systemctl --user is-active openclaw-gateway.service"'
        ]
      },
      TimeoutSeconds: 30
    });
    
    const sendResponse = await client.send(sendCommand);
    const commandId = sendResponse.Command?.CommandId;
    
    if (!commandId) {
      return { running: false, error: 'Failed to send command' };
    }
    
    // Wait a bit for command to execute
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get command result
    const getResult = new GetCommandInvocationCommand({
      CommandId: commandId,
      InstanceId: instanceId
    });
    
    const resultResponse = await client.send(getResult);
    const output = resultResponse.StandardOutputContent?.trim();
    
    return {
      running: output === 'active',
      error: output !== 'active' ? resultResponse.StandardErrorContent : undefined
    };
  } catch (error) {
    return { 
      running: false, 
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    client.destroy();
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
  const client = createCloudFormationClient(region);
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
      const ec2Client = createEc2Client(region);
      try {
        const instanceResponse = await ec2Client.send(
          new DescribeInstancesCommand({
            InstanceIds: [instanceId]
          })
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
    if (error instanceof Error && error.name === 'ValidationError') {
      throw new Error(`Stack '${stackName}' not found in region '${region}'`);
    }
    throw error;
  } finally {
    client.destroy();
  }
}

export async function getStackOutputs(
  stackName: string,
  region: string
): Promise<Record<string, string>> {
  const client = createCloudFormationClient(region);
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
  } finally {
    client.destroy();
  }
}
