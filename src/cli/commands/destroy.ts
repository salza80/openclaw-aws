import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import prompts from 'prompts';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig, configExists, getConfigPath } from '../utils/config.js';
import { getStackStatus } from '../utils/aws.js';
import { handleError, AWSError, withRetry } from '../utils/errors.js';
import { getCDKBinary } from '../utils/cdk.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DestroyArgs {
  force?: boolean;
  keepConfig?: boolean;
  config?: string;
}

export const destroyCommand: CommandModule<{}, DestroyArgs> = {
  command: 'destroy',
  describe: 'Delete all AWS resources',
  
  builder: (yargs) => {
    return yargs
      .option('force', {
        type: 'boolean',
        describe: 'Skip confirmation prompt',
        default: false,
      })
      .option('keep-config', {
        type: 'boolean',
        describe: 'Keep configuration file after destroying',
        default: false,
      })
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      });
  },
  
  handler: async (argv) => {
    try {
      // Load configuration
      const config = loadConfig(argv.config);
      
      logger.title('OpenClaw AWS - Destroy');

      // Try to get stack status
      let stackExists = true;
      let instanceId: string | undefined;
      
      const spinner = ora('Checking stack status...').start();
      try {
        const status = await getStackStatus(config.stack.name, config.aws.region);
        instanceId = status.instanceId;
        spinner.succeed(`Stack found: ${config.stack.name}`);
      } catch (error) {
        spinner.warn('Stack not found (may already be deleted)');
        stackExists = false;
      }

      if (!stackExists) {
        logger.info('No resources to delete');
        return;
      }

      // Show what will be deleted
      console.log('\n' + chalk.red('⚠ WARNING:') + ' This will permanently delete:\n');
      console.log(chalk.red('  ✗ EC2 instance: ' + config.instance.name + (instanceId ? ` (${instanceId})` : '')));
      console.log(chalk.red('  ✗ All data on the instance'));
      console.log(chalk.red('  ✗ Security group'));
      console.log(chalk.red('  ✗ IAM role'));
      console.log(chalk.red('  ✗ CloudFormation stack: ' + config.stack.name));
      console.log('\n' + chalk.bold('This action CANNOT be undone!\n'));

      // Confirmation
      if (!argv.force) {
        const { confirmText } = await prompts({
          type: 'text',
          name: 'confirmText',
          message: 'Type "DELETE" to confirm:',
          validate: (value) => value === 'DELETE' || 'You must type DELETE to confirm'
        });

        if (confirmText !== 'DELETE') {
          logger.warn('Destruction cancelled');
          return;
        }
      }

      // Get CDK binary (local from node_modules or global fallback)
      const cdkBinary = getCDKBinary();

      // Get CDK app path
      const cdkAppPath = path.resolve(__dirname, '../../cdk/app.js');
      
      // Set up environment
      const env: Record<string, string | undefined> = {
        ...process.env,
        AWS_REGION: config.aws.region,
      };

      if (config.aws.profile) {
        env.AWS_PROFILE = config.aws.profile;
      }

      // Destroy stack
      const destroySpinner = ora('Destroying stack... (this may take 3-5 minutes)').start();
      
      try {
        await execa(cdkBinary, [
          'destroy',
          '--app', `node ${cdkAppPath}`,
          '--force',
        ], { 
          env,
          cwd: process.cwd(),
        });

        destroySpinner.succeed('Stack destroyed successfully');
        logger.success('All resources removed');
        console.log('\nTotal cost: $0/month');

        // Ask about config file
        if (!argv.keepConfig && !argv.force) {
          const { deleteConfig } = await prompts({
            type: 'confirm',
            name: 'deleteConfig',
            message: 'Delete configuration file?',
            initial: false
          });

          if (deleteConfig) {
            const configPath = getConfigPath(argv.config);
            if (fs.existsSync(configPath)) {
              fs.unlinkSync(configPath);
              logger.success('Configuration file deleted');
            }
          } else {
            logger.info(`Configuration kept at ${getConfigPath(argv.config)}`);
          }
        } else if (!argv.keepConfig && argv.force) {
          // Auto-delete in force mode
          const configPath = getConfigPath(argv.config);
          if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
            logger.success('Configuration file deleted');
          }
        } else {
          logger.info(`Configuration kept at ${getConfigPath(argv.config)}`);
        }

      } catch (error) {
        destroySpinner.fail('Destruction failed');
        throw new AWSError('Stack destruction failed', [
          'Check AWS Console CloudFormation page for details',
          'Some resources may need manual cleanup',
          'Try running destroy again after a few minutes'
        ]);
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default destroyCommand;
