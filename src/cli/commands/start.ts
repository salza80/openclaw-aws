import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getInstanceIdFromStack, checkSSMStatus } from '../utils/aws.js';
import { startInstance, waitForInstanceState } from '../utils/ec2.js';
import { handleError } from '../utils/errors.js';
import { requireAwsCredentials } from '../utils/aws-validation.js';

interface StartArgs {
  config?: string;
}

export const startCommand: CommandModule<{}, StartArgs> = {
  command: 'start',
  describe: 'Start a stopped EC2 instance',
  
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
      
      logger.title('OpenClaw AWS - Start Instance');

      // Get instance ID
      const spinner = ora('Finding instance...').start();
      const instanceId = await getInstanceIdFromStack(config.stack.name, config.aws.region);
      spinner.succeed(`Found instance: ${chalk.cyan(instanceId)}`);

      // Start instance
      spinner.start('Starting instance...');
      await startInstance(instanceId, config.aws.region);
      spinner.text = 'Waiting for instance to start... (this may take 1-2 minutes)';
      
      const didStart = await waitForInstanceState(instanceId, config.aws.region, 'running', 180000);
      
      if (didStart) {
        spinner.succeed('Instance started successfully');
        
        // Check SSM connectivity
        spinner.start('Waiting for SSM to be ready...');
        let ssmReady = false;
        
        // Wait up to 2 minutes for SSM
        for (let i = 0; i < 24; i++) { // 24 * 5 seconds = 2 minutes
          ssmReady = await checkSSMStatus(instanceId, config.aws.region);
          if (ssmReady) break;
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        if (ssmReady) {
          spinner.succeed('Instance ready for connection');
        } else {
          spinner.warn('Instance running, SSM not ready yet');
          console.log('\nWait a minute then check: ' + chalk.cyan('openclaw-aws status'));
        }
        
        console.log('\n' + chalk.bold('Instance is now running'));
        console.log('\n' + chalk.bold('Next steps:'));
        console.log('  ' + chalk.cyan('openclaw-aws connect') + '    - Connect via SSM');
        console.log('  ' + chalk.cyan('openclaw-aws dashboard') + '  - Access dashboard');
        console.log('  ' + chalk.cyan('openclaw-aws stop') + '       - Stop to save costs');
        
      } else {
        spinner.warn('Instance start initiated (still starting...)');
        console.log('\nCheck status with: ' + chalk.cyan('openclaw-aws status'));
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default startCommand;
