import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { getStackOutputs } from '../utils/aws.js';
import { handleError, withRetry } from '../utils/errors.js';

interface OutputsArgs {
  config?: string;
}

export const outputsCommand: CommandModule<{}, OutputsArgs> = {
  command: 'outputs',
  describe: 'Show CloudFormation stack outputs',
  
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
      
      const spinner = ora('Fetching stack outputs...').start();
      
      try {
        const outputs = await withRetry(
          () => getStackOutputs(config.stack.name, config.aws.region),
          { maxAttempts: 2, operationName: 'get stack outputs' }
        );
        spinner.succeed('Outputs retrieved');

        logger.title('CloudFormation Outputs');

        if (Object.keys(outputs).length === 0) {
          console.log(chalk.yellow('No outputs found'));
          return;
        }

        // Display each output
        for (const [key, value] of Object.entries(outputs)) {
          console.log(chalk.bold(key + ':'));
          
          // Format commands nicely
          if (value.includes('aws ssm')) {
            // Multi-line command
            const parts = value.split(' --');
            console.log('  ' + chalk.cyan(parts[0]));
            parts.slice(1).forEach(part => {
              console.log('    ' + chalk.cyan('--' + part));
            });
          } else {
            console.log('  ' + chalk.cyan(value));
          }
          console.log('');
        }

        // Provide helpful tips
        console.log(chalk.bold('Quick Commands:'));
        console.log(`  ${chalk.cyan('openclaw-aws connect')}    - Use SSMConnectCommand`);
        console.log(`  ${chalk.cyan('openclaw-aws dashboard')}  - Use SSMPortForwardCommand`);

      } catch (error) {
        spinner.fail('Failed to get outputs');
        
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

export default outputsCommand;
