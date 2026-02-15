import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { resolveInstanceId, checkSSMStatus, waitForSSM } from '../utils/aws.js';
import { handleError, AWSError, withRetry, isRetryableError } from '../utils/errors.js';
import { validateSSMPlugin } from '../utils/aws-validation.js';

interface ConnectArgs {
  name?: string;
}

export const connectCommand: CommandModule<{}, ConnectArgs> = {
  command: 'connect',
  describe: 'Connect to EC2 instance via SSM',
  
  builder: (yargs) => {
    return yargs
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      });
  },
  
  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const config = ctx.config;
      
      // Validate SSM plugin is installed
      await validateSSMPlugin();

      logger.info(`Connecting ${chalk.cyan(ctx.name)}`);

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
      const env = ctx.awsEnv;

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
      } catch {
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
