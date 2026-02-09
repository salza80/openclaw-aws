import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import prompts from 'prompts';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getInstanceIdFromStack, checkSSMStatus } from '../utils/aws.js';
import { rebootInstance, waitForInstanceState } from '../utils/ec2.js';
import { handleError } from '../utils/errors.js';
import { requireAwsCredentials } from '../utils/aws-validation.js';

interface RestartArgs {
  config?: string;
  force?: boolean;
}

export const restartCommand: CommandModule<{}, RestartArgs> = {
  command: 'restart',
  describe: 'Restart (reboot) the EC2 instance',
  
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
      
      logger.title('OpenClaw AWS - Restart Instance');

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await getInstanceIdFromStack(config.stack.name, config.aws.region);
      spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);

      console.log('\n' + chalk.bold('Note:'));
      console.log('  • This will reboot the instance');
      console.log('  • OpenClaw service will restart automatically');
      console.log('  • Brief downtime (~1-2 minutes)');

      // Confirm
      if (!argv.force) {
        console.log('');
        const { confirm } = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: `Restart instance ${config.instance.name}?`,
          initial: true
        });

        if (!confirm) {
          logger.warn('Restart cancelled');
          return;
        }
      }

      // Reboot instance
      spinner.start('Rebooting instance...');
      await rebootInstance(instanceId, config.aws.region);
      spinner.succeed('Reboot initiated');
      
      spinner.start('Waiting for instance to restart... (this may take 1-2 minutes)');
      
      // Wait for instance to go through stopping and back to running
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s for reboot to start
      
      const didRestart = await waitForInstanceState(instanceId, config.aws.region, 'running', 180000);
      
      if (didRestart) {
        spinner.text = 'Waiting for SSM to be ready...';
        
        // Wait for SSM
        let ssmReady = false;
        for (let i = 0; i < 24; i++) { // 2 minutes
          ssmReady = await checkSSMStatus(instanceId, config.aws.region);
          if (ssmReady) break;
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        if (ssmReady) {
          spinner.succeed('Instance restarted and ready');
          logger.success('Instance is back online');
        } else {
          spinner.warn('Instance restarted, SSM not ready yet');
          console.log('\nWait a minute then check: ' + chalk.cyan('openclaw-aws status'));
        }
        
      } else {
        spinner.warn('Instance reboot in progress...');
        console.log('\nCheck status with: ' + chalk.cyan('openclaw-aws status'));
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default restartCommand;
