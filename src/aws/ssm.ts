import { setTimeout as delay } from 'node:timers/promises';
import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
} from '@aws-sdk/client-ssm';
import type { AwsLocation } from './target.js';
import { createSsmClient } from '../cli/utils/aws-clients.js';
import { AWSError } from '../cli/utils/errors.js';

export class RemoteCommandError extends AWSError {
  constructor(
    message: string,
    public readonly commandId?: string,
    public readonly status?: string,
  ) {
    super(message);
    this.name = 'RemoteCommandError';
  }
}
export interface RemoteResult {
  stdout: string;
  stderr: string;
  commandId: string;
}

/** Bounded Run Command execution. Payloads and remote output are never included in errors. */
export async function executeSsm(
  instanceId: string,
  target: AwsLocation,
  commands: string[],
  options: {
    executionSeconds?: number;
    deliverySeconds?: number;
    signal?: AbortSignal;
    pollMs?: number;
  } = {},
): Promise<RemoteResult> {
  const executionSeconds = options.executionSeconds ?? 60;
  const deliverySeconds = options.deliverySeconds ?? 30;
  if (
    !Number.isInteger(executionSeconds) ||
    executionSeconds < 1 ||
    executionSeconds > 172800 ||
    !Number.isInteger(deliverySeconds) ||
    deliverySeconds < 30 ||
    deliverySeconds > 2592000
  ) {
    throw new RemoteCommandError('Invalid remote command timeout');
  }
  const client = createSsmClient(target);
  let commandId: string | undefined;
  let completed = false;
  const durationMs = (deliverySeconds + executionSeconds + 10) * 1000;
  const deadline = Date.now() + durationMs;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(durationMs)])
    : AbortSignal.timeout(durationMs);
  try {
    const sent = await client.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands, executionTimeout: [String(executionSeconds)] },
        TimeoutSeconds: deliverySeconds,
      }),
      { abortSignal: signal },
    );
    commandId = sent.Command?.CommandId;
    if (!commandId) throw new RemoteCommandError('SSM did not return a command ID');
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const result = await client.send(
          new GetCommandInvocationCommand({
            InstanceId: instanceId,
            CommandId: commandId,
          }),
          { abortSignal: signal },
        );
        if (result.Status === 'Success') {
          completed = true;
          if (result.ResponseCode !== 0)
            throw new RemoteCommandError(
              'Remote command returned a nonzero exit code',
              commandId,
              result.Status,
            );
          const stdout = result.StandardOutputContent ?? '';
          const stderr = result.StandardErrorContent ?? '';
          // Inline SSM output is capped at 24,000 / 8,000 characters. Never parse
          // a potentially truncated native JSON response as a complete result.
          if (
            stdout.length >= 24000 ||
            stderr.length >= 8000 ||
            result.StandardOutputUrl ||
            result.StandardErrorUrl
          ) {
            throw new RemoteCommandError(
              'Remote output may be truncated; reduce the requested output',
              commandId,
              result.Status,
            );
          }
          return { stdout: stdout.trim(), stderr: stderr.trim(), commandId };
        }
        if (
          result.Status &&
          !['Pending', 'InProgress', 'Delayed', 'Cancelling'].includes(result.Status)
        ) {
          completed = true;
          throw new RemoteCommandError(
            `Remote command ended with status ${result.Status}`,
            commandId,
            result.Status,
          );
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'InvocationDoesNotExist') throw error;
      }
      await delay(options.pollMs ?? 1000, undefined, { signal });
    }
    throw new RemoteCommandError('Timed out waiting for remote command completion', commandId);
  } finally {
    if (commandId && !completed) {
      try {
        await client.send(
          new CancelCommandCommand({ CommandId: commandId, InstanceIds: [instanceId] }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
      } catch {
        /* best effort: the remote execution timeout remains in effect */
      }
    }
    client.destroy();
  }
}
