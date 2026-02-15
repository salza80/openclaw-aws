import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadOutputsByName } from '../utils/config.js';
import { buildCommandContext } from '../utils/context.js';
import { resolveInstanceId, checkSSMStatus, checkGatewayStatus } from '../utils/aws.js';
import { handleError, AWSError } from '../utils/errors.js';
import { validateSSMPlugin } from '../utils/aws-validation.js';
import net from 'net';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from '../utils/aws-clients.js';
import { getGatewayTokenParamName } from '../utils/api-keys.js';

interface DashboardArgs {
  name?: string;
  noOpen?: boolean;
}

async function waitForLocalPort(
  port: number,
  timeoutMs: number = 15000,
  intervalMs: number = 500
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      const onError = () => {
        socket.destroy();
        resolve(false);
      };
      socket.setTimeout(1000);
      socket.once('error', onError);
      socket.once('timeout', onError);
      socket.connect(port, '127.0.0.1', () => {
        socket.end();
        resolve(true);
      });
    });

    if (isOpen) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return false;
}

async function fetchGatewayToken(
  configName: string,
  region: string
): Promise<string | undefined> {
  const client = createSsmClient(region);
  const paramName = getGatewayTokenParamName(configName);
  try {
    const response = await client.send(new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    }));
    return response.Parameter?.Value;
  } catch {
    return undefined;
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
        instanceId = await resolveInstanceId(config.stack.name, config.aws.region);
        spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);
      } catch (error) {
        spinner.fail('Instance not found');
        throw error;
      }

      // Check SSM connectivity
      spinner.start('Checking SSM connectivity...');
      const isReady = await checkSSMStatus(instanceId, config.aws.region);
      
      if (!isReady) {
        spinner.fail('Instance not ready');
        throw new AWSError('Instance not ready for SSM connection', [
          'Run: openclaw-aws status (to check instance state)',
          'Run: openclaw-aws connect (which will wait for instance)',
          'The instance may still be starting up'
        ]);
      }
      spinner.succeed('Instance ready');

      spinner.start('Checking gateway status...');
      const gatewayStatus = await checkGatewayStatus(instanceId, config.aws.region);
      if (!gatewayStatus.running) {
        spinner.fail('Gateway not running');
        throw new AWSError('OpenClaw gateway is not running', [
          'Run: openclaw-aws status (to check gateway status)',
          'Run: openclaw-aws connect (to restart the gateway)',
          'If the instance is new, wait a few minutes and try again'
        ]);
      }
      spinner.succeed('Gateway running');

      // Set up environment
      const env = ctx.awsEnv;

      spinner.start('Setting up port forwarding...');

      // Start port forwarding
      // Note: This is a long-running process, so we don't await it
      const portForward = execa('aws', [
        'ssm', 'start-session',
        '--target', instanceId,
        '--document-name', 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify({
          portNumber: ['18789'],
          localPortNumber: ['18789']
        }),
        '--region', config.aws.region,
      ], {
        env,
      });

      // Wait a moment for port forwarding to establish
      await new Promise(resolve => setTimeout(resolve, 2000));

      spinner.succeed('Port forwarding established');

      // Get gateway token from outputs
      const outputs = loadOutputsByName(ctx.name);
      const stackOutputs = (outputs?.[config.stack.name] ?? {}) as {
        GatewayToken?: string;
        GatewayPort?: string;
      };
      let tokenSource: 'outputs' | 'ssm' | 'missing' = 'missing';
      let gatewayToken = stackOutputs.GatewayToken;
      if (!gatewayToken) {
        gatewayToken = await fetchGatewayToken(ctx.name, config.aws.region);
        tokenSource = gatewayToken ? 'ssm' : 'missing';
      } else {
        tokenSource = 'outputs';
      }
      const gatewayPort = stackOutputs.GatewayPort || '18789';
      const gatewayPortNumber = parseInt(gatewayPort, 10) || 18789;
      
      const dashboardUrl = gatewayToken 
        ? `http://localhost:${gatewayPort}/?token=${gatewayToken}`
        : `http://localhost:${gatewayPort}`;

      console.log('\n' + '='.repeat(50));
      logger.success('Dashboard Available!');
      console.log('='.repeat(50));
      console.log(`\n🌐 Dashboard URL: ${chalk.cyan(dashboardUrl)}`);
      
      if (gatewayToken) {
        console.log(`\n🔑 Gateway Token (${tokenSource}): ${chalk.gray(gatewayToken)}`);
      } else {
        console.log(`\n${chalk.yellow('⚠️  Gateway token could not be retrieved.')}`);
        console.log(`   Checked: CloudFormation outputs and SSM Parameter Store.`);
        console.log(`   Dashboard auth may fail without ?token=<value> in the URL.`);
      }
      
      if (!argv.noOpen) {
        spinner.start('Waiting for dashboard to become ready...');
        const ready = await waitForLocalPort(gatewayPortNumber);
        if (ready) {
          spinner.succeed('Dashboard ready');
        } else {
          spinner.warn('Dashboard not ready yet; opening anyway');
        }

        if (!gatewayToken) {
          console.log('\nSkipping automatic browser open because gateway token is missing.');
          console.log('Use openclaw-aws logs --service to inspect gateway startup/auth configuration.');
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

      // Handle cleanup
      process.on('SIGINT', () => {
        console.log('\n\nStopping port forwarding...');
        portForward.kill('SIGTERM');
        process.exit(0);
      });

      // Keep process alive
      await portForward;

    } catch (error) {
      handleError(error);
    }
  },
};

export default dashboardCommand;
