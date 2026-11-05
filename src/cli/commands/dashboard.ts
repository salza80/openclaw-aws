import type { AwsLocation } from '../../aws/target.js';
import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadOutputsByName } from '../utils/config.js';
import { buildCommandContext } from '../utils/context.js';
import { resolveInstanceId, checkSSMStatus, checkGatewayStatus } from '../utils/aws.js';
import { handleError, AWSError } from '../utils/errors.js';
import { validateSSMPlugin } from '../utils/aws-validation.js';
import { startDashboardTunnel } from '../../aws/tunnel.js';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from '../utils/aws-clients.js';
import { getGatewayTokenParamName } from '../utils/api-keys.js';

interface DashboardArgs {
  name?: string;
  noOpen?: boolean;
  localPort?: number;
  showToken?: boolean;
}

async function fetchGatewayToken(
  configName: string,
  region: AwsLocation,
): Promise<string | undefined> {
  const client = createSsmClient(region);
  const paramName = getGatewayTokenParamName(configName);
  try {
    const response = await client.send(
      new GetParameterCommand({
        Name: paramName,
        WithDecryption: true,
      }),
    );
    return response.Parameter?.Value;
  } catch {
    return undefined;
  } finally {
    client.destroy();
  }
}

export const dashboardCommand: CommandModule<{}, DashboardArgs> = {
  command: 'dashboard',
  describe: 'Forward port 18789 for OpenClaw dashboard access',

  builder: (yargs) => {
    return yargs
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      })
      .option('local-port', {
        type: 'number',
        describe: 'Local port (automatically selects a free port by default)',
      })
      .option('show-token', {
        type: 'boolean',
        default: false,
        describe: 'Explicitly print the private authenticated dashboard URL',
      })
      .option('no-open', {
        type: 'boolean',
        describe: 'Do not open browser automatically',
        default: false,
      });
  },

  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const config = ctx.config;

      // Validate SSM plugin is installed
      await validateSSMPlugin();

      logger.info(`Opening dashboard for ${chalk.cyan(ctx.name)}`);

      // Get instance ID
      const spinner = ora('Finding instance...').start();

      let instanceId: string;
      try {
        instanceId = await resolveInstanceId(config.stack.name, ctx.target);
        spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);
      } catch (error) {
        spinner.fail('Instance not found');
        throw error;
      }

      // Check SSM connectivity
      spinner.start('Checking SSM connectivity...');
      const isReady = await checkSSMStatus(instanceId, ctx.target);

      if (!isReady) {
        spinner.fail('Instance not ready');
        throw new AWSError('Instance not ready for SSM connection', [
          'Run: openclaw-aws status (to check instance state)',
          'Run: openclaw-aws connect (which will wait for instance)',
          'The instance may still be starting up',
        ]);
      }
      spinner.succeed('Instance ready');

      spinner.start('Checking gateway status...');
      const gatewayStatus = await checkGatewayStatus(instanceId, ctx.target);
      if (!gatewayStatus.running) {
        spinner.fail('Gateway not running');
        throw new AWSError('OpenClaw gateway is not running', [
          'Run: openclaw-aws status (to check gateway status)',
          'Run: openclaw-aws connect (to restart the gateway)',
          'If the instance is new, wait a few minutes and try again',
        ]);
      }
      spinner.succeed('Gateway running');

      spinner.start('Setting up port forwarding...');
      const tunnel = await startDashboardTunnel({
        instanceId,
        target: ctx.target,
        localPort: argv.localPort,
      });
      let cleanupRequested = false;
      const cleanup = () => {
        cleanupRequested = true;
        tunnel.stop();
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
      try {
        spinner.succeed('Port forwarding established');

        // Get gateway token from outputs
        const outputs = loadOutputsByName(ctx.name);
        const stackOutputs = (outputs?.[config.stack.name] ?? {}) as {
          GatewayToken?: string;
          GatewayPort?: string;
        };
        let gatewayToken = stackOutputs.GatewayToken;
        if (!gatewayToken) {
          gatewayToken = await fetchGatewayToken(ctx.name, ctx.target);
        }
        const publicUrl = `http://localhost:${tunnel.port}`;
        const dashboardUrl = gatewayToken
          ? `${publicUrl}/#token=${encodeURIComponent(gatewayToken)}`
          : publicUrl;

        console.log('\n' + '='.repeat(50));
        logger.success('Dashboard Available!');
        console.log('='.repeat(50));
        console.log(`\n🌐 Dashboard URL: ${chalk.cyan(argv.showToken ? dashboardUrl : publicUrl)}`);

        if (gatewayToken) {
          console.log(
            argv.showToken
              ? '\nKeep the authenticated URL private.'
              : '\nThe browser receives the gateway token privately; use --show-token to explicitly print it.',
          );
        } else {
          console.log(`\n${chalk.yellow('⚠️  Gateway token could not be retrieved.')}`);
          console.log(`   Checked: CloudFormation outputs and SSM Parameter Store.`);
          console.log(`   Open the dashboard through this command to pass its token privately.`);
        }

        if (!argv.noOpen) {
          if (!gatewayToken) {
            console.log('\nSkipping automatic browser open because gateway token is missing.');
            console.log(
              'Use openclaw-aws logs --service to inspect gateway startup/auth configuration.',
            );
          } else {
            console.log('\n📖 Opening in your default browser...');
            try {
              // Try to open browser (cross-platform)
              const { execa: execaSync } = await import('execa');
              if (process.platform === 'darwin') {
                await execaSync('open', [dashboardUrl]);
              } else if (process.platform === 'win32') {
                await execaSync('cmd', ['/c', 'start', dashboardUrl]);
              } else {
                await execaSync('xdg-open', [dashboardUrl]);
              }
            } catch {
              // Silently fail if browser open doesn't work
              console.log('\n(Could not open browser automatically)');
            }
          }
        }

        console.log(`\n${chalk.bold('Keep this terminal window open')}`);
        console.log(`Press ${chalk.yellow('Ctrl+C')} to stop port forwarding\n`);

        // Keep process alive until session ends or user interrupts
        await tunnel.done;
      } catch (error) {
        if (!cleanupRequested) {
          throw error;
        }
      } finally {
        tunnel.stop();
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
      }
    } catch (error) {
      handleError(error);
    }
  },
};

export default dashboardCommand;
