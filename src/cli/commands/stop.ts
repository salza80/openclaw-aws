import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import prompts from 'prompts';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getInstanceIdFromStack } from '../utils/aws.js';
import { stopInstance, waitForInstanceState } from '../utils/ec2.js';
import { handleError } from '../utils/errors.js';
import { requireAwsCredentials } from '../utils/aws-validation.js';

interface StopArgs {
  config?: string;
  force?: boolean;
}

export const stopCommand: CommandModule<{}, StopArgs> = {
  command: 'stop',
  describe: 'Stop the EC2 instance (saves ~90% on costs)',
  
  builder: (yargs) => {
    return yargs
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      })
      .option('force', {
        type: 'boolean',
        describe: 'Skip confirmation prompt',
        default: false,
      });
  },
  
  handler: async (argv) => {
    try {
      const config = loadConfig(argv.config);

      await requireAwsCredentials(config);
      
      logger.title('OpenClaw AWS - Stop Instance');

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await getInstanceIdFromStack(config.stack.name, config.aws.region);
      spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);

      // Show cost savings
      console.log('\n' + chalk.bold('Cost Savings:'));
      console.log('  Running:  ~$8.30/month');
      console.log('  Stopped:  ~$0.80/month (EBS storage only)');
      console.log('  ' + chalk.green('Savings:  ~$7.50/month (~90%)'));

      console.log('\n' + chalk.bold('Note:'));
      console.log('  • Instance data is preserved');
      console.log('  • Restart anytime with: ' + chalk.cyan('openclaw-aws start'));
      console.log('  • IP address may change after restart');

      // Confirm
      if (!argv.force) {
        console.log('');
        const { confirm } = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: `Stop instance ${config.instance.name}?`,
          initial: true
        });

        if (!confirm) {
          logger.warn('Stop cancelled');
          return;
        }
      }

      // Stop instance
      spinner.start('Stopping instance...');
      await stopInstance(instanceId, config.aws.region);
      spinner.text = 'Waiting for instance to stop...';
      
      const didStop = await waitForInstanceState(instanceId, config.aws.region, 'stopped', 120000);
      
      if (didStop) {
        spinner.succeed('Instance stopped successfully');
        logger.success('Instance is now stopped');
        console.log('\n' + chalk.bold('To restart:'));
        console.log('  ' + chalk.cyan('openclaw-aws start'));
      } else {
        spinner.warn('Instance stop initiated (still stopping...)');
        console.log('\nCheck status with: ' + chalk.cyan('openclaw-aws status'));
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default stopCommand;
