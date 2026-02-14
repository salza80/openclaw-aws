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
    send: sendMock
  }))
}));

vi.mock('@aws-sdk/client-ssm', () => {
  class SendCommandCommand {
    input: any;
    constructor(input: any) { this.input = input; }
  }
  class GetCommandInvocationCommand {
    input: any;
    constructor(input: any) { this.input = input; }
  }
  return { SendCommandCommand, GetCommandInvocationCommand };
});

import { SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import logsCommand from '../../src/cli/commands/logs.js';

describe('logs command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows init and service logs by default', async () => {
    let capturedCommands: string[] = [];
    sendMock.mockImplementation(async (command: any) => {
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
    await handler({ _: [], $0: 'openclaw-aws' } as any);

    const commandText = capturedCommands.join('\n');
    expect(commandText).toContain('/var/log/cloud-init-output.log');
    expect(commandText).toContain('/var/log/cloud-init.log');
    expect(commandText).toContain('/var/log/user-data.log');
    expect(commandText).toContain('journalctl --user -u openclaw-gateway.service');
    expect(commandText).toContain('journalctl --user -u openclaw-daemon.service');
  });

  it('supports --init only', async () => {
    let capturedCommands: string[] = [];
    sendMock.mockImplementation(async (command: any) => {
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
    await handler({ init: true, _: [], $0: 'openclaw-aws' } as any);

    const commandText = capturedCommands.join('\n');
    expect(commandText).toContain('/var/log/cloud-init-output.log');
    expect(commandText).not.toContain('journalctl --user -u openclaw-gateway.service');
  });

  it('supports --service only', async () => {
    let capturedCommands: string[] = [];
    sendMock.mockImplementation(async (command: any) => {
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
    await handler({ service: true, _: [], $0: 'openclaw-aws' } as any);

    const commandText = capturedCommands.join('\n');
    expect(commandText).toContain('journalctl --user -u openclaw-gateway.service');
    expect(commandText).not.toContain('/var/log/cloud-init-output.log');
  });
});
