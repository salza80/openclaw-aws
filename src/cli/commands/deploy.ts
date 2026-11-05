import type { CommandModule } from 'yargs';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { handleError, AWSError, StackNotFoundError } from '../utils/errors.js';
import { validatePreDeploy, validateNodeVersion } from '../utils/aws-validation.js';
import { buildCommandContext } from '../utils/context.js';
import { validateProvisioningConfig } from '../utils/config-validation.js';
import { getStackStatus } from '../utils/aws.js';
import { resolveOutputsPath } from '../utils/config-store.js';
import { listConfigNames } from '../utils/config-store.js';
import path from 'path';
import fs from 'fs';
import prompts from 'prompts';
import { config as loadEnv } from 'dotenv';
import type { Provider } from '../types/index.js';
import { getApiKeyEnvVar, resolveApiKey } from '../utils/api-keys.js';

import { deployDeployment, rejectFailedStack } from '../../operations/deployment.js';

loadEnv({ path: path.join(process.cwd(), '.env') });

interface DeployArgs {
  autoApprove?: boolean;
  name?: string;
  all?: boolean;
}

export const deployCommand: CommandModule<{}, DeployArgs> = {
  command: 'deploy',
  describe: 'Deploy OpenClaw infrastructure to AWS',

  builder: (yargs) => {
    return yargs
      .option('auto-approve', {
        type: 'boolean',
        describe: 'Skip confirmation prompt',
        default: false,
      })
      .option('name', {
        type: 'string',
        describe: 'Deployment name',
      })
      .option('all', {
        type: 'boolean',
        describe: 'Deploy all configurations',
        default: false,
      });
  },

  handler: async (argv) => {
    try {
      await deployConfigured(argv);
    } catch (error) {
      handleError(error);
    }
  },
};

export async function deployConfigured(argv: DeployArgs): Promise<void> {
  // Validate Node version
  validateNodeVersion();

  if (argv.all) {
    const names = listConfigNames();
    if (names.length === 0) {
      logger.info('No configs found');
      console.log('\nRun: ' + chalk.cyan('openclaw-aws init --name <name>'));
      return;
    }

    const toDeploy: Array<{
      name: string;
      context: Awaited<ReturnType<typeof buildCommandContext>>;
      apiProvider: Provider;
      apiKey: string;
    }> = [];
    const alreadyDeployed: Array<{ name: string; status: string }> = [];
    const missingKeys: Array<{ name: string; envVar: string }> = [];

    for (const name of names) {
      const ctx = await buildCommandContext({ name });
      const config = ctx.config;

      try {
        const status = await getStackStatus(config.stack.name, ctx.target);
        rejectFailedStack(name, config, status.stackStatus);
        alreadyDeployed.push({ name, status: status.stackStatus });
        continue;
      } catch (error) {
        if (!(error instanceof StackNotFoundError)) {
          throw error;
        }
      }

      validateProvisioningConfig(config);
      const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key';
      const apiKeyEnvVar = getApiKeyEnvVar(apiProvider);
      const apiKey = resolveApiKey(apiProvider);
      if (!apiKey) {
        missingKeys.push({ name, envVar: apiKeyEnvVar });
        continue;
      }

      toDeploy.push({ name, context: ctx, apiProvider, apiKey });
    }

    if (missingKeys.length > 0) {
      throw new AWSError(
        `Missing API keys for ${missingKeys.length} config(s): ${missingKeys
          .map((item) => item.name)
          .join(', ')}`,
        [
          'Set them in your shell or .env before deploying:',
          ...missingKeys.map((item) => `  ${item.name}: ${item.envVar}=your-api-key`),
        ],
      );
    }

    if (toDeploy.length === 0) {
      logger.info('All configs are already deployed');
      return;
    }

    logger.title('OpenClaw AWS - Deploy All');
    if (alreadyDeployed.length > 0) {
      console.log(chalk.gray(`Skipping ${alreadyDeployed.length} already deployed config(s).`));
    }
    console.log(chalk.bold('Configs to deploy:') + ` (${toDeploy.length})`);
    toDeploy.forEach((item) => console.log('  - ' + chalk.cyan(item.name)));

    const { confirmText } = await prompts({
      type: 'text',
      name: 'confirmText',
      message: `This will deploy ${toDeploy.length} instance(s). Type "DEPLOY ALL" to confirm:`,
      validate: (value) => value === 'DEPLOY ALL' || 'You must type DEPLOY ALL to confirm',
    });

    if (confirmText !== 'DEPLOY ALL') {
      logger.warn('Deploy cancelled');
      return;
    }

    for (const target of toDeploy) {
      const ctx = target.context;
      const config = ctx.config;

      logger.title('OpenClaw AWS - Deploy');
      logger.info(`Deploying ${chalk.cyan(ctx.name)}`);

      validateProvisioningConfig(config);
      await validatePreDeploy(config, ctx.target);
      console.log('');

      // Show deployment plan
      logger.info('Deployment Plan:');
      console.log(`  Stack: ${chalk.cyan(config.stack.name)}`);
      console.log(`  Region: ${chalk.cyan(config.aws.region)}`);
      console.log(
        `  Instance: ${chalk.cyan(config.instance.type)} (${chalk.cyan(config.instance.name)})`,
      );
      console.log(`  Resources:`);
      console.log(`    - EC2 Instance (${config.instance.type})`);
      console.log(`    - Security Group (no inbound rules)`);
      console.log(`    - IAM Role (SSM access only)`);

      const spinner = ora('Preparing deployment...').start();
      try {
        await deployDeployment(ctx, {
          apiProvider: target.apiProvider,
          apiKey: target.apiKey,
          progress: (message) => {
            spinner.text = message;
          },
        });
        spinner.succeed('OpenClaw is ready and reachable through SSM');
      } catch (error) {
        spinner.fail('Deployment failed');
        throw error;
      }
    }

    return;
  }

  // Load and validate configuration
  const ctx = await buildCommandContext({ name: argv.name });
  const config = ctx.config;

  logger.title('OpenClaw AWS - Deploy');
  logger.info(`Deploying ${chalk.cyan(ctx.name)}`);

  // Check if stack already exists
  const statusSpinner = ora('Checking existing deployment...').start();
  try {
    const status = await getStackStatus(config.stack.name, ctx.target);
    rejectFailedStack(ctx.name, config, status.stackStatus);
    statusSpinner.succeed('Existing deployment found');
    logger.info(`Stack ${chalk.cyan(config.stack.name)} already exists (${status.stackStatus})`);
    console.log('\n' + chalk.bold('Next steps:'));
    console.log('  ' + chalk.cyan('openclaw-aws status') + '     - Check instance status');
    console.log('  ' + chalk.cyan('openclaw-aws connect') + '    - Connect via SSM');
    console.log('  ' + chalk.cyan('openclaw-aws dashboard') + '  - Access dashboard');
    return;
  } catch (error) {
    statusSpinner.stop();
    if (!(error instanceof StackNotFoundError)) {
      throw error;
    }
  }

  validateProvisioningConfig(config);

  console.log(''); // Empty line after validation

  const apiProvider = config.openclaw?.apiProvider || 'anthropic-api-key';
  const apiKeyEnvVar = getApiKeyEnvVar(apiProvider);
  const apiKey = resolveApiKey(apiProvider);
  if (!apiKey) {
    throw new AWSError(`Missing API key: ${apiKeyEnvVar}`, [
      `Set it in your shell: export ${apiKeyEnvVar}=your-api-key`,
      `Or add it to .env in your current directory: ${apiKeyEnvVar}=your-api-key`,
      'Then rerun: openclaw-aws deploy',
    ]);
  }

  await validatePreDeploy(config, ctx.target);
  // Show deployment plan
  logger.info('Deployment Plan:');
  console.log(`  Stack: ${chalk.cyan(config.stack.name)}`);
  console.log(`  Region: ${chalk.cyan(config.aws.region)}`);
  console.log(
    `  Instance: ${chalk.cyan(config.instance.type)} (${chalk.cyan(config.instance.name)})`,
  );
  console.log(`  Resources:`);
  console.log(`    - EC2 Instance (${config.instance.type})`);
  console.log(`    - Security Group (no inbound rules)`);
  console.log(`    - IAM Role (SSM access only)`);

  // Confirm deployment
  if (!argv.autoApprove) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Confirm deployment?',
      initial: true,
    });

    if (!confirm) {
      logger.warn('Deployment cancelled');
      return;
    }
  }

  const spinner = ora('Preparing deployment...').start();
  try {
    const stackOutputs = await deployDeployment(ctx, {
      apiProvider,
      apiKey,
      progress: (message) => {
        spinner.text = message;
      },
    });
    spinner.succeed('OpenClaw is ready and reachable through SSM');
    const outputsFile = resolveOutputsPath(ctx.name);
    // Read and display outputs
    if (fs.existsSync(outputsFile)) {
      console.log('\n' + '='.repeat(50));
      logger.success('Deployment Complete!');
      console.log('='.repeat(50));

      if (stackOutputs.InstanceId) {
        console.log(`\n${chalk.bold('Instance ID:')} ${chalk.cyan(stackOutputs.InstanceId)}`);
      }
      if (stackOutputs.InstanceName) {
        console.log(`${chalk.bold('Instance Name:')} ${chalk.cyan(stackOutputs.InstanceName)}`);
      }

      console.log('\n' + chalk.bold('Next steps:'));
      console.log(
        '  ' + chalk.cyan('1.') + ' OpenClaw installation and Gateway health have been verified',
      );
      console.log(
        '  ' + chalk.cyan('2.') + ' Check status: ' + chalk.yellow('openclaw-aws status'),
      );
      console.log(
        '  ' + chalk.cyan('3.') + ' Access dashboard: ' + chalk.yellow('openclaw-aws dashboard'),
      );
      console.log(
        ' ' + chalk.cyan('or') + ' Connect to terminal: ' + chalk.yellow('openclaw-aws connect'),
      );

      console.log(
        '\n' +
          chalk.gray('💡 Tip: Use ') +
          chalk.cyan('openclaw-aws logs --init') +
          chalk.gray(' to view installation logs'),
      );
    }
  } catch (error) {
    spinner.fail('Deployment failed');
    throw error;
  }
}

export default deployCommand;
