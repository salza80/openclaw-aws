import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { saveConfig, configExists } from '../utils/config.js';
import { validateProjectName, validateInstanceName, AWS_REGIONS, INSTANCE_TYPES } from '../utils/validation.js';
import { handleError } from '../utils/errors.js';
import type { OpenClawConfig } from '../types/index.js';

interface InitArgs {
  region?: string;
  instanceType?: string;
  yes?: boolean;
}

export const initCommand: CommandModule<{}, InitArgs> = {
  command: 'init',
  describe: 'Initialize OpenClaw AWS deployment configuration',
  
  builder: (yargs) => {
    return yargs
      .option('region', {
        type: 'string',
        describe: 'AWS region',
      })
      .option('instance-type', {
        type: 'string',
        describe: 'EC2 instance type',
      })
      .option('yes', {
        type: 'boolean',
        alias: 'y',
        describe: 'Use default values (non-interactive)',
        default: false,
      });
  },
  
  handler: async (argv) => {
    try {
      logger.title('OpenClaw AWS - Deployment Setup Wizard');

      // Check if config already exists
      if (configExists()) {
        const { overwrite } = await prompts({
          type: 'confirm',
          name: 'overwrite',
          message: 'Configuration file already exists. Overwrite?',
          initial: false
        });

        if (!overwrite) {
          logger.info('Configuration unchanged');
          return;
        }
      }

      let config: OpenClawConfig;

      if (argv.yes) {
        // Use defaults
        config = {
          version: '1.0',
          projectName: 'my-openclaw-bot',
          aws: {
            region: argv.region || 'us-east-1',
          },
          instance: {
            type: argv.instanceType || 't3.micro',
            name: 'openclaw-my-openclaw-bot',
            nodeVersion: 22,
            amiType: 'amazon-linux-2',
          },
          features: {
            cloudWatchLogs: true,
          },
          stack: {
            name: 'OpenclawStack-my-openclaw-bot',
          },
        };
      } else {
        // Interactive prompts
        const answers = await prompts([
          {
            type: 'text',
            name: 'projectName',
            message: 'Project name:',
            initial: 'my-openclaw-bot',
            validate: (value) => validateProjectName(value) === true ? true : String(validateProjectName(value))
          },
          {
            type: 'select',
            name: 'region',
            message: 'AWS Region:',
            choices: AWS_REGIONS,
            initial: 0
          },
          {
            type: 'select',
            name: 'instanceType',
            message: 'EC2 Instance type:',
            choices: INSTANCE_TYPES,
            initial: 0
          },
          {
            type: 'text',
            name: 'instanceName',
            message: 'Instance name:',
            initial: (prev: any, values: any) => `openclaw-${values.projectName}`,
            validate: (value) => validateInstanceName(value) === true ? true : String(validateInstanceName(value))
          },
          {
            type: 'confirm',
            name: 'cloudWatchLogs',
            message: 'Enable CloudWatch Logs?',
            initial: true
          },
        ]);

        // Check if user cancelled
        if (!answers.projectName) {
          logger.warn('Setup cancelled');
          return;
        }

        config = {
          version: '1.0',
          projectName: answers.projectName,
          aws: {
            region: argv.region || answers.region,
          },
          instance: {
            type: argv.instanceType || answers.instanceType,
            name: answers.instanceName,
            nodeVersion: 22,
            amiType: 'amazon-linux-2',
          },
          features: {
            cloudWatchLogs: answers.cloudWatchLogs,
          },
          stack: {
            name: `OpenclawStack-${answers.projectName}`,
          },
        };
      }

      // Save configuration
      saveConfig(config);
      logger.success('Configuration saved to .openclaw-aws/config.json');

      // Display summary
      console.log('\n' + chalk.bold('Configuration Summary:'));
      console.log(`  ${chalk.bold('Project:')} ${chalk.cyan(config.projectName)}`);
      console.log(`  ${chalk.bold('Region:')} ${chalk.cyan(config.aws.region)}`);
      console.log(`  ${chalk.bold('Instance:')} ${chalk.cyan(config.instance.type)}`);
      console.log(`  ${chalk.bold('Name:')} ${chalk.cyan(config.instance.name)}`);
      console.log(`  ${chalk.bold('Stack:')} ${chalk.cyan(config.stack.name)}`);

      // Ask to deploy now
      if (!argv.yes) {
        console.log('');
        const { deployNow } = await prompts({
          type: 'confirm',
          name: 'deployNow',
          message: 'Deploy now?',
          initial: false
        });

        if (deployNow) {
          console.log('\n' + chalk.yellow('→') + ' To deploy, run: ' + chalk.cyan('openclaw-aws deploy'));
        } else {
          console.log('\n' + chalk.gray('When ready, run: ' + chalk.cyan('openclaw-aws deploy')));
        }
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default initCommand;
