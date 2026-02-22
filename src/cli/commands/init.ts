import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { saveConfigByName, configExistsByName } from '../utils/config.js';
import { setCurrentName } from '../utils/config-store.js';
import {
  validateProjectName,
  validateInstanceName,
  AWS_REGIONS,
  INSTANCE_TYPES,
} from '../utils/validation.js';
import { handleError, ValidationError } from '../utils/errors.js';
import type { OpenClawConfig, Provider } from '../types/index.js';
import { API_PROVIDERS } from '../constants.js';
import { ensureEnvFiles } from '../utils/env-files.js';

interface InitArgs {
  folder?: string;
  name?: string;
  region?: string;
  instanceType?: string;
  yes?: boolean;
  apiProvider?: Provider;
}

function hasExistingSetup(directory: string): boolean {
  return fs.existsSync(path.join(directory, '.openclaw-aws', 'configs'));
}

function resolveTargetDir(baseDir: string, folderInput?: string): { targetDir: string; created: boolean } {
  const folderName = folderInput?.trim();
  if (!folderName) {
    return { targetDir: baseDir, created: false };
  }

  const targetDir = path.resolve(baseDir, folderName);
  if (fs.existsSync(targetDir)) {
    if (!fs.statSync(targetDir).isDirectory()) {
      throw new ValidationError(`Path exists and is not a directory: ${targetDir}`, [
        'Choose a different folder and rerun: openclaw-aws init',
      ]);
    }
    return { targetDir, created: false };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  return { targetDir, created: true };
}

export const initCommand: CommandModule<{}, InitArgs> = {
  command: 'init [folder]',
  describe: 'Initialize OpenClaw AWS deployment configuration',

  builder: (yargs) => {
    return yargs
      .positional('folder', {
        type: 'string',
        describe: 'Folder to initialize (created if missing)',
      })
      .option('region', {
        type: 'string',
        describe: 'AWS region',
      })
      .option('name', {
        type: 'string',
        describe: 'Deployment name (unique)',
      })
      .option('instance-type', {
        type: 'string',
        describe: 'EC2 instance type',
      })
      .option('api-provider', {
        type: 'string',
        describe: 'API provider',
        choices: API_PROVIDERS.map((p) => p.value),
      })
      .option('yes', {
        type: 'boolean',
        alias: 'y',
        describe: 'Use default values (non-interactive)',
        default: false,
      });
  },

  handler: async (argv) => {
    const originalCwd = process.cwd();

    try {
      logger.title('OpenClaw AWS - Deployment Setup Wizard');
      const apiProviderValues = API_PROVIDERS.map((p) => p.value);

      if (argv.apiProvider && !apiProviderValues.includes(argv.apiProvider)) {
        throw new ValidationError(`Invalid API provider: ${argv.apiProvider}`, [
          `Valid providers: ${apiProviderValues.join(', ')}`,
        ]);
      }

      let config: OpenClawConfig;
      let deploymentName = argv.name;
      let folderNameFromPrompt: string | undefined;

      if (argv.yes) {
        // Use defaults
        const apiProvider = (argv.apiProvider as Provider) || 'anthropic-api-key';
        deploymentName = deploymentName || 'my-openclaw-bot';

        config = {
          version: '1.0',
          aws: {
            region: argv.region || 'us-east-1',
          },
          network: {
            useDefaultVpc: true,
          },
          instance: {
            type: argv.instanceType || 't3.small',
            name: `openclaw-${deploymentName}`,
          },
          features: {
            cloudWatchLogs: true,
          },
          stack: {
            name: `OpenclawStack-${deploymentName}`,
          },
          openclaw: {
            apiProvider,
          },
        };
      } else {
        const shouldPromptForFolder = !argv.folder && !hasExistingSetup(originalCwd);

        // Interactive prompts
        const questions = [
          ...(shouldPromptForFolder
            ? [
                {
                  type: 'text',
                  name: 'folderName',
                  message: 'Folder name (leave blank to use current folder):',
                  initial: '',
                  validate: (value: string) => {
                    const normalized = value.trim();
                    if (!normalized) return true;
                    const validation = validateProjectName(normalized);
                    return validation === true ? true : `Folder name: ${String(validation)}`;
                  },
                },
              ]
            : []),
          {
            type: 'text',
            name: 'deploymentName',
            message: 'Deployment name (unique):',
            initial: deploymentName,
            validate: (value: string) =>
              validateProjectName(value) === true
                ? true
                : `Name your bot. ${String(validateProjectName(value))}`,
          },
          {
            type: 'select',
            name: 'region',
            message: 'AWS Region:',
            choices: AWS_REGIONS,
            initial: 0,
          },
          {
            type: 'select',
            name: 'useDefaultVpc',
            message: 'VPC Configuration:',
            choices: [
              {
                title: 'Use default VPC (recommended)',
                value: true,
                description: 'Simpler, faster, uses existing VPC',
              },
              {
                title: 'Create new VPC',
                value: false,
                description: 'Dedicated isolated VPC for OpenClaw',
              },
            ],
            initial: 0,
          },
          {
            type: 'select',
            name: 'instanceType',
            message: 'EC2 Instance type:',
            choices: INSTANCE_TYPES,
            initial: 0,
          },
          {
            type: 'text',
            name: 'instanceName',
            message: 'Instance name:',
            initial: (_prev: string, values: { deploymentName: string }) =>
              `openclaw-${values.deploymentName}`,
            validate: (value: string) =>
              validateInstanceName(value) === true ? true : String(validateInstanceName(value)),
          },
          {
            type: 'select',
            name: 'apiProvider',
            message: 'Select AI API Provider:',
            choices: [...API_PROVIDERS],
            initial: 0,
          },
          {
            type: 'confirm',
            name: 'cloudWatchLogs',
            message: 'Enable CloudWatch Logs?',
            initial: true,
          },
        ] as any;
        const answers = await prompts(questions);

        // Check if user cancelled
        if (!answers.deploymentName) {
          logger.warn('Setup cancelled');
          return;
        }

        folderNameFromPrompt = answers.folderName;
        deploymentName = answers.deploymentName;

        config = {
          version: '1.0',
          aws: {
            region: argv.region || answers.region,
          },
          network: {
            useDefaultVpc: answers.useDefaultVpc,
          },
          instance: {
            type: argv.instanceType || answers.instanceType,
            name: `openclaw-${deploymentName}`,
          },
          features: {
            cloudWatchLogs: answers.cloudWatchLogs,
          },
          stack: {
            name: `OpenclawStack-${deploymentName}`,
          },
          openclaw: {
            apiProvider: answers.apiProvider,
          },
        };

        // Show warnings after config created
        if (!config.network.useDefaultVpc) {
          logger.info('ℹ️  Note: A new VPC will be created for this deployment');
        }
      }

      if (!deploymentName) {
        throw new Error('Deployment name is required');
      }

      const { targetDir, created } = resolveTargetDir(originalCwd, argv.folder || folderNameFromPrompt);
      if (targetDir !== originalCwd) {
        process.chdir(targetDir);
      }

      if (configExistsByName(deploymentName)) {
        const { overwrite } = await prompts({
          type: 'confirm',
          name: 'overwrite',
          message: `Deployment "${deploymentName}" already exists. Overwrite?`,
          initial: false,
        });

        if (!overwrite) {
          logger.info('Configuration unchanged');
          return;
        }
      }

      if (created) {
        logger.success(`Created folder: ${chalk.cyan(targetDir)}`);
      }

      logger.info(`Creating deployment ${chalk.cyan(deploymentName)}`);

      // Save configuration
      saveConfigByName(config, deploymentName);
      logger.success(`Configuration saved for "${deploymentName}"`);
      setCurrentName(deploymentName);

      const envResult = ensureEnvFiles(process.cwd());
      if (envResult.createdEnvExample) {
        logger.success(`Created ${chalk.cyan('.env.example')} with API key placeholders`);
      }
      if (envResult.createdEnv) {
        logger.success(`Created ${chalk.cyan('.env')} template. Add your API key before deploy.`);
      } else {
        logger.info(`${chalk.cyan('.env')} already exists. Keeping existing values.`);
      }

      // Display summary
      console.log('\n' + chalk.bold('Configuration Summary:'));
      console.log(`  ${chalk.bold('Deployment:')} ${chalk.cyan(deploymentName)}`);
      console.log(`  ${chalk.bold('Region:')} ${chalk.cyan(config.aws.region)}`);
      console.log(`  ${chalk.bold('Instance:')} ${chalk.cyan(config.instance.type)}`);
      console.log(`  ${chalk.bold('Name:')} ${chalk.cyan(config.instance.name)}`);
      console.log(`  ${chalk.bold('AMI:')} ${chalk.cyan('Ubuntu 24.04 LTS')}`);
      console.log(`  ${chalk.bold('Node.js:')} ${chalk.cyan('22 (hardcoded)')}`);
      console.log(`  ${chalk.bold('Stack:')} ${chalk.cyan(config.stack.name)}`);
      console.log(
        `  ${chalk.bold('API Provider:')} ${chalk.cyan(config.openclaw?.apiProvider || 'anthropic')}`,
      );

      // Show required environment variable
      const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key';
      const envVarName = apiProvider.toUpperCase().replace(/-/g, '_');
      console.log(`\n${chalk.yellow('⚠ Required before deployment:')}`);
      console.log(`  Set your API key: export ${envVarName}=your-api-key`);
      console.log(`  Or add it to .env: ${envVarName}=your-api-key`);

      if (apiProvider === 'openrouter-api-key') {
        console.log(`  Get your key: https://openrouter.ai/keys`);
      } else if (apiProvider === 'anthropic-api-key') {
        console.log(`  Get your key: https://console.anthropic.com/settings/keys`);
      } else if (apiProvider === 'openai-api-key') {
        console.log(`  Get your key: https://platform.openai.com/api-keys`);
      }

      // Ask to deploy now
      if (!argv.yes) {
        console.log('');
        const { deployNow } = await prompts({
          type: 'confirm',
          name: 'deployNow',
          message: 'Deploy now?',
          initial: false,
        });

        if (deployNow) {
          console.log('');
          await import('./deploy.js').then(({ default: deployCommand }) =>
            deployCommand.handler?.({
              name: deploymentName,
              autoApprove: false,
              _: [],
              $0: 'openclaw-aws',
            } as Parameters<NonNullable<typeof deployCommand.handler>>[0]),
          );
        } else {
          console.log(`\n${chalk.bold('Next steps:')}`);
          console.log(`  Set your API key: ${chalk.cyan(`export ${envVarName}=your-api-key`)}`);
          console.log(`  Or add it to .env: ${chalk.cyan(`${envVarName}=your-api-key`)}`);
          console.log(`  When you're ready, run: ${chalk.cyan('openclaw-aws deploy')}`);
        }
      }
    } catch (error) {
      handleError(error);
    } finally {
      process.chdir(originalCwd);
    }
  },
};

export default initCommand;
