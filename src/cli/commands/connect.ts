import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getInstanceIdFromStack, checkSSMStatus, waitForSSM } from '../utils/aws.js';
import { handleError, AWSError, withRetry, isRetryableError } from '../utils/errors.js';
import { requireAwsCredentials, validateSSMPlugin } from '../utils/aws-validation.js';

interface ConnectArgs {
  config?: string;
}

export const connectCommand: CommandModule<{}, ConnectArgs> = {
  command: 'connect',
  describe: 'Connect to EC2 instance via SSM',
  
  builder: (yargs) => {
    return yargs
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      });
  },
  
  handler: async (argv) => {
    try {
      const config = loadConfig(argv.config);

      await requireAwsCredentials(config);
      
      // Validate SSM plugin is installed
      await validateSSMPlugin();

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      
      let instanceId: string;
      try {
        instanceId = await withRetry(
          () => getInstanceIdFromStack(config.stack.name, config.aws.region),
          { maxAttempts: 2, operationName: 'get instance ID' }
        );
        spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);
      } catch (error) {
        spinner.fail('Instance not found');
        throw new AWSError('Could not find instance', [
          'Run: openclaw-aws deploy (to create instance)',
          'Run: openclaw-aws status (to check deployment)'
        ]);
      }

      // Check SSM connectivity
      spinner.start('Checking SSM connectivity...');
      const isReady = await checkSSMStatus(instanceId, config.aws.region);
      
      if (!isReady) {
        spinner.text = chalk.yellow('Instance not ready, waiting...') + ' (this may take a few minutes)';
        const didBecomeReady = await waitForSSM(instanceId, config.aws.region, 180000, 10000);
        
        if (!didBecomeReady) {
          spinner.fail('Instance SSM not ready after 3 minutes');
          throw new AWSError('Instance not ready for SSM connection', [
            'The instance may still be starting up',
            'Wait a few more minutes and try again',
            'Run: openclaw-aws status (to check instance state)'
          ]);
        }
        spinner.succeed('Instance ready for connection');
      } else {
        spinner.succeed('Instance ready for connection');
      }

      // Set up environment
      const env: Record<string, string | undefined> = {
        ...process.env,
        AWS_REGION: config.aws.region,
      };

      if (config.aws.profile) {
        env.AWS_PROFILE = config.aws.profile;
      }

      console.log('');
      logger.info(`Connecting to ${chalk.cyan(config.instance.name)} (${chalk.gray(instanceId)})...`);
      console.log(chalk.gray('(To exit, type "exit" or press Ctrl+D)'));
      console.log('');

      // Launch SSM session with retry
      try {
        await withRetry(
          () => execa('aws', [
            'ssm', 'start-session',
            '--target', instanceId,
            '--region', config.aws.region,
            '--document-name', 'AWS-StartInteractiveCommand',
            '--parameters', 'command="sudo su - ubuntu"',
          ], { 
            stdio: 'inherit',
            env,
          }),
          {
            maxAttempts: 3,
            delayMs: 2000,
            shouldRetry: (error) => isRetryableError(error),
            operationName: 'start SSM session'
          }
        );
      } catch (error) {
        throw new AWSError('Failed to start SSM session', [
          'Check your internet connection',
          'Verify AWS credentials are valid',
          'Try again in a few moments'
        ]);
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default connectCommand;
