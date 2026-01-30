import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getStackStatus } from '../utils/aws.js';
import { handleError, withRetry } from '../utils/errors.js';

interface StatusArgs {
  config?: string;
}

export const statusCommand: CommandModule<{}, StatusArgs> = {
  command: 'status',
  describe: 'Check deployment and instance status',
  
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
      
      const spinner = ora('Checking status...').start();
      
      try {
        const status = await withRetry(
          () => getStackStatus(config.stack.name, config.aws.region),
          { maxAttempts: 2, operationName: 'get stack status' }
        );
        spinner.succeed('Status retrieved');

        // Display status
        logger.title('OpenClaw AWS - Deployment Status');

        console.log(chalk.bold('Stack:'), config.stack.name);
        
        // Stack status with color
        let stackStatusDisplay = status.stackStatus;
        if (status.stackStatus.includes('COMPLETE')) {
          stackStatusDisplay = chalk.green('✓ ' + status.stackStatus);
        } else if (status.stackStatus.includes('FAILED')) {
          stackStatusDisplay = chalk.red('✗ ' + status.stackStatus);
        } else if (status.stackStatus.includes('PROGRESS')) {
          stackStatusDisplay = chalk.yellow('⚙ ' + status.stackStatus);
        }
        
        console.log(chalk.bold('Status:'), stackStatusDisplay, chalk.gray(`(${config.aws.region})`));

        // Instance info if available
        if (status.instanceId) {
          console.log('\n' + chalk.bold('Instance:'), config.instance.name, chalk.gray(`(${status.instanceId})`));
          
          if (status.instanceStatus) {
            let instanceStatusDisplay = status.instanceStatus;
            if (status.instanceStatus === 'running') {
              instanceStatusDisplay = chalk.green('✓ Running');
            } else if (status.instanceStatus === 'stopped') {
              instanceStatusDisplay = chalk.yellow('⚠ Stopped');
            } else if (status.instanceStatus === 'terminated') {
              instanceStatusDisplay = chalk.red('✗ Terminated');
            } else {
              instanceStatusDisplay = chalk.yellow('⚙ ' + status.instanceStatus);
            }
            console.log(chalk.bold('Status:'), instanceStatusDisplay);
          }

          if (status.ssmStatus) {
            const ssmDisplay = status.ssmStatus === 'ready' 
              ? chalk.green('✓ Ready') 
              : chalk.yellow('⚠ Not Ready');
            console.log(chalk.bold('SSM:'), ssmDisplay);
          }

          console.log(chalk.bold('Type:'), config.instance.type);
        }

        // OpenClaw Gateway status
        console.log('\n' + chalk.bold('OpenClaw Gateway:'));
        console.log(chalk.bold('Status:'), chalk.yellow('⚠ Unknown'), chalk.gray('(run openclaw-aws dashboard to check)'));

        // Quick commands
        console.log('\n' + chalk.bold('Quick Commands:'));
        console.log(`  ${chalk.cyan('openclaw-aws connect')}    - Connect via SSM`);
        console.log(`  ${chalk.cyan('openclaw-aws dashboard')}  - Access dashboard`);
        console.log(`  ${chalk.cyan('openclaw-aws destroy')}    - Delete deployment`);

      } catch (error) {
        spinner.fail('Failed to get status');
        
        if (error instanceof Error && error.message.includes('not found')) {
          console.log('\n' + chalk.yellow('⚠ No deployment found'));
          console.log('\nRun: ' + chalk.cyan('openclaw-aws deploy'));
        } else {
          throw error;
        }
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default statusCommand;
