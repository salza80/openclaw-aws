import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadOutputs } from '../utils/config.js';
import { buildCommandContext } from '../utils/context.js';
import { resolveInstanceId, checkSSMStatus } from '../utils/aws.js';
import { handleError, AWSError } from '../utils/errors.js';
import { validateSSMPlugin } from '../utils/aws-validation.js';

interface DashboardArgs {
  config?: string;
  noOpen?: boolean;
}

export const dashboardCommand: CommandModule<{}, DashboardArgs> = {
  command: 'dashboard',
  describe: 'Forward port 18789 for OpenClaw dashboard access',
  
  builder: (yargs) => {
    return yargs
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      })
      .option('no-open', {
        type: 'boolean',
        describe: 'Do not open browser automatically',
        default: false,
      });
  },
  
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ configPath: argv.config });
      const config = ctx.config;
      
      // Validate SSM plugin is installed
      await validateSSMPlugin();

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
      const outputs = loadOutputs(ctx.configPath);
      const stackOutputs = outputs?.[config.stack.name] || {};
      const gatewayToken = stackOutputs.GatewayToken;
      const gatewayPort = stackOutputs.GatewayPort || '18789';
      
      const dashboardUrl = gatewayToken 
        ? `http://localhost:${gatewayPort}/?token=${gatewayToken}`
        : `http://localhost:${gatewayPort}`;

      console.log('\n' + '='.repeat(50));
      logger.success('Dashboard Available!');
      console.log('='.repeat(50));
      console.log(`\n🌐 Dashboard URL: ${chalk.cyan(dashboardUrl)}`);
      
      if (gatewayToken) {
        console.log(`\n🔑 Gateway Token: ${chalk.gray(gatewayToken)}`);
      } else {
        console.log(`\n${chalk.yellow('⚠️  Gateway token not found in outputs.')}`);
        console.log(`   You may need to manually add ?token=<your-token> to the URL`);
      }
      
      if (!argv.noOpen) {
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
