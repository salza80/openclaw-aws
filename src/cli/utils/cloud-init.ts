import { GetConsoleOutputCommand } from '@aws-sdk/client-ec2';
import { withRetry } from './errors.js';
import { createEc2Client } from './aws-clients.js';

export interface CloudInitStatus {
  isComplete: boolean;
  hasError: boolean;
  isOpenClawInstalled: boolean;
  errorMessage?: string;
  elapsedMinutes?: number;
}

export async function checkCloudInitStatus(
  instanceId: string,
  region: string
): Promise<CloudInitStatus> {
  const client = createEc2Client(region);
  const command = new GetConsoleOutputCommand({
    InstanceId: instanceId,
    Latest: true
  });

  try {
    const response = await withRetry(
      () => client.send(command),
      { maxAttempts: 2, operationName: 'get console output' }
    );

    const output = response.Output || '';

    // Check if cloud-init finished
    const isComplete = output.includes('Cloud-init v.') && output.includes('finished at');
    
    // Check for errors
    const hasError = output.includes('npm error') || 
                     output.includes('Error:') || 
                     output.includes('FAILED') ||
                     output.includes('command not found') && !isComplete;

    // Check if OpenClaw installed successfully
    const isOpenClawInstalled = output.includes('OpenClaw CLI installed successfully') ||
                                (output.includes('openclaw@') && output.includes('added'));

    // Extract error message if present
    let errorMessage: string | undefined;
    if (hasError && !isComplete) {
      const errorMatch = output.match(/npm error (.*?)$/m) || 
                        output.match(/Error: (.*?)$/m);
      if (errorMatch) {
        errorMessage = errorMatch[1].trim();
      }
    }

    // Calculate elapsed time
    let elapsedMinutes: number | undefined;
    const launchMatch = output.match(/started at (.*?)\./);
    const finishMatch = output.match(/finished at (.*?)\./);
    if (launchMatch && finishMatch) {
      const start = new Date(launchMatch[1]);
      const end = new Date(finishMatch[1]);
      elapsedMinutes = Math.round((end.getTime() - start.getTime()) / 1000 / 60);
    }

    return {
      isComplete,
      hasError,
      isOpenClawInstalled,
      errorMessage,
      elapsedMinutes
    };

  } catch (error) {
    // If we can't get console output, assume not ready
    return {
      isComplete: false,
      hasError: false,
      isOpenClawInstalled: false
    };
  }
}

export async function getConsoleOutput(
  instanceId: string,
  region: string
): Promise<string> {
  const client = createEc2Client(region);
  const command = new GetConsoleOutputCommand({
    InstanceId: instanceId,
    Latest: true
  });

  try {
    const response = await withRetry(
      () => client.send(command),
      { maxAttempts: 2, operationName: 'get console output' }
    );
    return response.Output || '';
  } catch {
    return '';
  }
}

export function getInstallationProgress(output: string): string {
  if (output.includes('OpenClaw CLI installed successfully')) {
    return 'OpenClaw installation complete ✅';
  } else if (output.includes('npm install -g openclaw')) {
    return 'Installing OpenClaw CLI... (this takes 5-10 minutes)';
  } else if (output.includes('nodejs') && output.includes('Installing')) {
    return 'Installing Node.js...';
  } else if (output.includes('NodeSource')) {
    return 'Setting up Node.js repository...';
  } else if (output.includes('update -y')) {
    return 'Updating system packages...';
  } else {
    return 'Instance starting up...';
  }
}
