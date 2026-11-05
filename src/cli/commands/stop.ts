import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import prompts from 'prompts';
import { logger } from '../utils/logger.js';
import { buildCommandContext } from '../utils/context.js';
import { resolveInstanceId } from '../utils/aws.js';
import { getInstanceState, stopInstance, waitForInstanceState } from '../utils/ec2.js';
import { handleError } from '../utils/errors.js';

interface StopArgs {
  name?: string;
  force?: boolean;
}

export const stopCommand: CommandModule<{}, StopArgs> = {
  command: 'stop',
  describe: 'Stop the EC2 instance (saves ~90% on costs)',

  builder: (yargs) => {
    return yargs
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      })
      .option('force', {
        type: 'boolean',
        describe: 'Skip confirmation prompt',
        default: false,
      });
  },

  handler: async (argv) => {
    try {
      const ctx = await buildCommandContext({ name: argv.name });
      const config = ctx.config;

      logger.title('OpenClaw AWS - Stop Instance');
      logger.info(`Stopping ${chalk.cyan(ctx.name)}`);

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await resolveInstanceId(config.stack.name, ctx.target);
      spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);

      const currentState = await getInstanceState(instanceId, ctx.target);
      if (currentState === 'stopped') {
        logger.info('Instance is already stopped');
        console.log('\n' + chalk.bold('To restart:'));
        console.log('  ' + chalk.cyan('openclaw-aws start'));
        return;
      }

      console.log('\n' + chalk.bold('While stopped:'));
      console.log(
        '  EC2 compute charges stop. EBS storage and other retained AWS resources can still incur charges.',
      );

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
          initial: true,
        });

        if (!confirm) {
          logger.warn('Stop cancelled');
          return;
        }
      }

      // Stop instance
      spinner.start('Stopping instance...');
      await stopInstance(instanceId, ctx.target);
      spinner.text = 'Waiting for instance to stop...';

      const didStop = await waitForInstanceState(instanceId, ctx.target, 'stopped', 120000);

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
