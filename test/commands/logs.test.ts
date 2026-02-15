import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CommandModule } from 'yargs';

vi.mock('../../src/cli/utils/context.js', () => ({
  buildCommandContext: vi.fn(async () => ({
    name: 'alpha',
    config: {
      aws: { region: 'us-east-1' },
      stack: { name: 'OpenclawStack-alpha' }
    },
    configPath: '/tmp/alpha.json',
    awsEnv: {}
  }))
}));

vi.mock('../../src/cli/utils/aws.js', () => ({
  resolveInstanceId: vi.fn(async () => 'i-123'),
  checkSSMStatus: vi.fn(async () => true)
}));

vi.mock('../../src/cli/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    title: vi.fn(),
    box: vi.fn()
  }
}));

const sendMock = vi.fn();

vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: vi.fn(() => ({
    send: sendMock,
    destroy: vi.fn()
  }))
}));

vi.mock('@aws-sdk/client-ssm', () => {
  interface MockSendCommandInput {
    Parameters: {
      commands: string[];
    };
  }

  interface MockGetCommandInvocationInput {
    CommandId: string;
    InstanceId: string;
  }

  class SendCommandCommand {
    input: MockSendCommandInput;
    constructor(input: MockSendCommandInput) { this.input = input; }
  }
  class GetCommandInvocationCommand {
    input: MockGetCommandInvocationInput;
    constructor(input: MockGetCommandInvocationInput) { this.input = input; }
  }
  return { SendCommandCommand, GetCommandInvocationCommand };
});

import { SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import logsCommand from '../../src/cli/commands/logs.js';

type LogsHandler = NonNullable<(typeof logsCommand)['handler']>;
type LogsHandlerArgs = Parameters<LogsHandler>[0];

describe('logs command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows init and service logs by default', async () => {
    let capturedCommands: string[] = [];
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof SendCommandCommand) {
        capturedCommands = command.input.Parameters.commands;
        return { Command: { CommandId: 'cmd-1' } };
      }
      if (command instanceof GetCommandInvocationCommand) {
        return { Status: 'Success', StandardOutputContent: 'OK', StandardErrorContent: '' };
      }
      return {};
    });

    const handler = (logsCommand as CommandModule).handler!;
    const args: LogsHandlerArgs = { _: [], $0: 'openclaw-aws' };
    await handler(args);

    const commandText = capturedCommands.join('\n');
    expect(commandText).toContain('/var/log/cloud-init-output.log');
    expect(commandText).toContain('/var/log/cloud-init.log');
    expect(commandText).toContain('/var/log/user-data.log');
    expect(commandText).toContain('journalctl --user -u openclaw-gateway.service');
    expect(commandText).toContain('journalctl --user -u openclaw-daemon.service');
  });

  it('supports --init only', async () => {
    let capturedCommands: string[] = [];
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof SendCommandCommand) {
        capturedCommands = command.input.Parameters.commands;
        return { Command: { CommandId: 'cmd-2' } };
      }
      if (command instanceof GetCommandInvocationCommand) {
        return { Status: 'Success', StandardOutputContent: 'OK', StandardErrorContent: '' };
      }
      return {};
    });

    const handler = (logsCommand as CommandModule).handler!;
    const args: LogsHandlerArgs = { init: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    const commandText = capturedCommands.join('\n');
    expect(commandText).toContain('/var/log/cloud-init-output.log');
    expect(commandText).not.toContain('journalctl --user -u openclaw-gateway.service');
  });

  it('supports --service only', async () => {
    let capturedCommands: string[] = [];
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof SendCommandCommand) {
        capturedCommands = command.input.Parameters.commands;
        return { Command: { CommandId: 'cmd-3' } };
      }
      if (command instanceof GetCommandInvocationCommand) {
        return { Status: 'Success', StandardOutputContent: 'OK', StandardErrorContent: '' };
      }
      return {};
    });

    const handler = (logsCommand as CommandModule).handler!;
    const args: LogsHandlerArgs = { service: true, _: [], $0: 'openclaw-aws' };
    await handler(args);

    const commandText = capturedCommands.join('\n');
    expect(commandText).toContain('journalctl --user -u openclaw-gateway.service');
    expect(commandText).not.toContain('/var/log/cloud-init-output.log');
  });
});
