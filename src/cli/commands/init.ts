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
  apiProvider?: string;
  model?: string;
}

// API Provider options
const API_PROVIDERS = [
  { title: 'Anthropic (Claude)', value: 'anthropic', description: 'Official Anthropic API (claude.ai)' },
  { title: 'OpenRouter', value: 'openrouter', description: 'Multi-provider API (100+ models)' },
  { title: 'OpenAI (GPT)', value: 'openai', description: 'Official OpenAI API' },
  { title: 'Custom', value: 'custom', description: 'Custom API endpoint' },
];

// Default models for each provider
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'anthropic/claude-sonnet-4',
  openrouter: 'openrouter/anthropic/claude-sonnet-4',
  openai: 'gpt-4',
  custom: 'custom-model',
};

// Environment variable names for each provider
const API_KEY_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  custom: 'CUSTOM_API_KEY',
};

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
      .option('api-provider', {
        type: 'string',
        describe: 'API provider (anthropic, openrouter, openai, custom)',
      })
      .option('model', {
        type: 'string',
        describe: 'AI model to use',
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
        const apiProvider = (argv.apiProvider as 'anthropic' | 'openrouter' | 'openai' | 'custom') || 'anthropic';
        const model = argv.model || DEFAULT_MODELS[apiProvider];
        
        config = {
          version: '1.0',
          projectName: 'my-openclaw-bot',
          aws: {
            region: argv.region || 'us-east-1',
          },
          network: {
            useDefaultVpc: true,
          },
          instance: {
            type: argv.instanceType || 't3.micro',
            name: 'openclaw-my-openclaw-bot',
            nodeVersion: 22,
          },
          security: {
            enableSsh: false,
            sshSourceIp: '0.0.0.0/0',
          },
          features: {
            cloudWatchLogs: true,
          },
          stack: {
            name: 'OpenclawStack-my-openclaw-bot',
          },
          openclaw: {
            apiProvider,
            model,
            enableSandbox: true,
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
            name: 'useDefaultVpc',
            message: 'VPC Configuration:',
            choices: [
              { 
                title: 'Use default VPC (recommended)', 
                value: true,
                description: 'Simpler, faster, uses existing VPC'
              },
              { 
                title: 'Create new VPC', 
                value: false,
                description: 'Dedicated isolated VPC for OpenClaw'
              },
            ],
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
            type: 'select',
            name: 'apiProvider',
            message: 'Select AI API Provider:',
            choices: API_PROVIDERS,
            initial: 0
          },
          {
            type: 'text',
            name: 'model',
            message: 'AI Model:',
            initial: (prev: any, values: any) => DEFAULT_MODELS[values.apiProvider],
            hint: 'Press Enter for default model'
          },
          {
            type: 'confirm',
            name: 'enableSsh',
            message: 'Enable SSH access? (SSM Session Manager is recommended)',
            initial: false
          },
          {
            type: (prev: boolean) => prev ? 'text' : null,
            name: 'sshSourceIp',
            message: 'SSH source IP/CIDR (0.0.0.0/0 for anywhere, or your IP/32):',
            initial: '0.0.0.0/0',
            validate: (value: string) => {
              const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
              return cidrPattern.test(value) || 'Invalid CIDR notation (e.g., 203.0.113.0/24 or 1.2.3.4/32)';
            }
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
          network: {
            useDefaultVpc: answers.useDefaultVpc,
          },
          instance: {
            type: argv.instanceType || answers.instanceType,
            name: answers.instanceName,
            nodeVersion: 22,
          },
          security: {
            enableSsh: answers.enableSsh,
            sshSourceIp: answers.sshSourceIp || '0.0.0.0/0',
          },
          features: {
            cloudWatchLogs: answers.cloudWatchLogs,
          },
          stack: {
            name: `OpenclawStack-${answers.projectName}`,
          },
          openclaw: {
            apiProvider: answers.apiProvider,
            model: answers.model,
            enableSandbox: true,
          },
        };

        // Show warnings after config created
        if (!config.network.useDefaultVpc) {
          logger.info('ℹ️  Note: A new VPC will be created for this deployment');
        }

        if (config.security?.enableSsh) {
          logger.warn('⚠️  Warning: SSH is enabled. Instance will accept connections from ' + 
                      (config.security.sshSourceIp || '0.0.0.0/0'));
          logger.info('💡 Tip: SSM Session Manager is more secure and requires no open ports');
        }
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
      console.log(`  ${chalk.bold('AMI:')} ${chalk.cyan('Amazon Linux 2023')}`);
      console.log(`  ${chalk.bold('Node.js:')} ${chalk.cyan('v22')}`);
      console.log(`  ${chalk.bold('Stack:')} ${chalk.cyan(config.stack.name)}`);
      console.log(`  ${chalk.bold('API Provider:')} ${chalk.cyan(config.openclaw?.apiProvider || 'anthropic')}`);
      console.log(`  ${chalk.bold('Model:')} ${chalk.cyan(config.openclaw?.model || 'default')}`);

      // Show required environment variable
      const apiProvider = config.openclaw?.apiProvider || 'anthropic';
      const envVarName = API_KEY_ENV_VARS[apiProvider];
      console.log(`\n${chalk.yellow('⚠ Required before deployment:')}`);
      console.log(`  Set your API key: export ${envVarName}=your-api-key`);
      
      if (apiProvider === 'openrouter') {
        console.log(`  Get your key: https://openrouter.ai/keys`);
      } else if (apiProvider === 'anthropic') {
        console.log(`  Get your key: https://console.anthropic.com/settings/keys`);
      } else if (apiProvider === 'openai') {
        console.log(`  Get your key: https://platform.openai.com/api-keys`);
      }

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
