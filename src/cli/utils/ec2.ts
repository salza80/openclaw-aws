import { EC2Client, StopInstancesCommand, StartInstancesCommand, RebootInstancesCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { withRetry, AWSError } from './errors.js';

export async function stopInstance(instanceId: string, region: string): Promise<void> {
  const client = new EC2Client({ region });
  const command = new StopInstancesCommand({
    InstanceIds: [instanceId]
  });

  try {
    await withRetry(
      () => client.send(command),
      { maxAttempts: 2, operationName: 'stop instance' }
    );
  } catch (error) {
    throw new AWSError(`Failed to stop instance ${instanceId}`, [
      'Check instance exists and is in a stoppable state',
      'Verify IAM permissions for ec2:StopInstances'
    ]);
  }
}

export async function startInstance(instanceId: string, region: string): Promise<void> {
  const client = new EC2Client({ region });
  const command = new StartInstancesCommand({
    InstanceIds: [instanceId]
  });

  try {
    await withRetry(
      () => client.send(command),
      { maxAttempts: 2, operationName: 'start instance' }
    );
  } catch (error) {
    throw new AWSError(`Failed to start instance ${instanceId}`, [
      'Check instance exists and is in a stopped state',
      'Verify IAM permissions for ec2:StartInstances'
    ]);
  }
}

export async function rebootInstance(instanceId: string, region: string): Promise<void> {
  const client = new EC2Client({ region });
  const command = new RebootInstancesCommand({
    InstanceIds: [instanceId]
  });

  try {
    await withRetry(
      () => client.send(command),
      { maxAttempts: 2, operationName: 'reboot instance' }
    );
  } catch (error) {
    throw new AWSError(`Failed to reboot instance ${instanceId}`, [
      'Check instance exists and is running',
      'Verify IAM permissions for ec2:RebootInstances'
    ]);
  }
}

export async function waitForInstanceState(
  instanceId: string,
  region: string,
  desiredState: 'running' | 'stopped',
  maxWaitTime: number = 180000 // 3 minutes
): Promise<boolean> {
  const client = new EC2Client({ region });
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const response = await client.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );
      
      const instance = response.Reservations?.[0]?.Instances?.[0];
      const currentState = instance?.State?.Name;
      
      if (currentState === desiredState) {
        return true;
      }
      
      // Wait 5 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch {
      // Continue waiting
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  return false;
}
