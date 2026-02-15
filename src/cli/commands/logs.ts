import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { resolveInstanceId, checkSSMStatus } from '../utils/aws.js';
import { handleError, AWSError } from '../utils/errors.js';
import { createSsmClient } from '../utils/aws-clients.js';
import { SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';

interface LogsArgs {
  name?: string;
  init?: boolean;
  service?: boolean;
  tail?: number;
  follow?: boolean;
}

function buildInitCommands(tail: number): string[] {
  const files = [
    '/var/log/cloud-init-output.log',
    '/var/log/cloud-init.log',
    '/var/log/user-data.log'
  ];

  const commands: string[] = [];
  for (const file of files) {
    commands.push(`echo "== ${file} =="`);
    commands.push(`sudo tail -n ${tail} ${file} 2>/dev/null || echo "(missing)"`);
    commands.push('echo ""');
  }
  return commands;
}

function buildServiceCommands(tail: number): string[] {
  const env = 'XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus';
  const commands: string[] = [];
  commands.push('echo "== openclaw-gateway.service =="');
  commands.push(`sudo -u ubuntu ${env} journalctl --user -u openclaw-gateway.service -n ${tail} --no-pager || echo "(no logs)"`);
  commands.push('echo ""');
  commands.push('echo "== openclaw-daemon.service =="');
  commands.push(`sudo -u ubuntu ${env} journalctl --user -u openclaw-daemon.service -n ${tail} --no-pager || echo "(no logs)"`);
  commands.push('echo ""');
  return commands;
}

async function runSsmCommand(
  instanceId: string,
  region: string,
  commands: string[],
  timeoutSeconds: number = 30
): Promise<{ stdout: string; stderr: string }> {
  const client = createSsmClient(region);
  try {
    const send = await client.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands },
      TimeoutSeconds: timeoutSeconds
    }));

    const commandId = send.Command?.CommandId;
    if (!commandId) {
      throw new AWSError('Failed to send SSM command', [
        'Check instance status: openclaw-aws status',
        'Try again in a few minutes'
      ]);
    }

    const start = Date.now();
    while (Date.now() - start < timeoutSeconds * 1000) {
      const result = await client.send(new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId
      }));

      if (result.Status && ['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(result.Status)) {
        return {
          stdout: result.StandardOutputContent?.trim() ?? '',
          stderr: result.StandardErrorContent?.trim() ?? ''
        };
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new AWSError('Timed out waiting for logs', [
      'Try again with a smaller --tail value',
      'Check instance health: openclaw-aws status'
    ]);
  } finally {
    client.destroy();
  }
}

export const logsCommand: CommandModule<{}, LogsArgs> = {
  command: 'logs',
  describe: 'Fetch instance logs (init and service)',
  
  builder: (yargs) => {
    return yargs
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      })
      .option('init', {
        type: 'boolean',
        describe: 'Show init/cloud-init logs',
        default: false,
      })
      .option('service', {
        type: 'boolean',
        describe: 'Show OpenClaw service logs',
        default: false,
      })
      .option('tail', {
        type: 'number',
        describe: 'Number of lines to show',
        default: 200,
      })
      .option('follow', {
        type: 'boolean',
        describe: 'Poll logs periodically (like tail -f)',
        default: false,
      });
  },
  
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const config = ctx.config;
      const tail = argv.tail && argv.tail > 0 ? Math.floor(argv.tail) : 200;
      const showInit = argv.init || (!argv.init && !argv.service);
      const showService = argv.service || (!argv.init && !argv.service);

      logger.info(`Fetching logs for ${chalk.cyan(ctx.name)}`);

      const spinner = ora('Finding instance...').start();
      let instanceId: string;
      try {
        instanceId = await resolveInstanceId(config.stack.name, config.aws.region);
        spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);
      } catch (error) {
        spinner.fail('Instance not found');
        throw error;
      }

      spinner.start('Checking SSM connectivity...');
      const isReady = await checkSSMStatus(instanceId, config.aws.region);
      if (!isReady) {
        spinner.fail('Instance not ready');
        throw new AWSError('Instance not ready for SSM log retrieval', [
          'Run: openclaw-aws status (to check instance state)',
          'Wait a few minutes and try again'
        ]);
      }
      spinner.succeed('Instance ready');

      const commands = [
        ...(showInit ? buildInitCommands(tail) : []),
        ...(showService ? buildServiceCommands(tail) : []),
      ];

      const printOnce = async () => {
        const result = await runSsmCommand(instanceId, config.aws.region, commands, 60);
        if (result.stdout) console.log(result.stdout);
        if (result.stderr) console.log(chalk.yellow(result.stderr));
      };

      if (!argv.follow) {
        await printOnce();
        return;
      }

      logger.info('Follow mode enabled (polling every 2s). Press Ctrl+C to stop.');
      let stopped = false;
      process.on('SIGINT', () => {
        stopped = true;
      });

      while (!stopped) {
        console.log('\n' + chalk.gray(`--- ${new Date().toISOString()} ---`));
        await printOnce();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      handleError(error);
    }
  },
};

export default logsCommand;
