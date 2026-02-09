import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { handleError, AWSError, withRetry, isRetryableError } from '../utils/errors.js';
import { validatePreDeploy, validateNodeVersion } from '../utils/aws-validation.js';
import { getCDKBinary } from '../utils/cdk.js';
import { buildCommandContext } from '../utils/context.js';
import { getStackStatus } from '../utils/aws.js';
import { resolveOutputsPath } from '../utils/config-store.js';
import { listConfigNames } from '../utils/config-store.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import prompts from 'prompts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      // Validate Node version
      validateNodeVersion();

      if (argv.all) {
        const names = listConfigNames();
        if (names.length === 0) {
          logger.info('No configs found');
          console.log('\nRun: ' + chalk.cyan('openclaw-aws init --name <name>'));
          return;
        }

        logger.title('OpenClaw AWS - Deploy All');
        console.log(chalk.bold('Configs to deploy:') + ` (${names.length})`);
        names.forEach((name) => console.log('  - ' + chalk.cyan(name)));

        const { confirmText } = await prompts({
          type: 'text',
          name: 'confirmText',
          message: 'Type "DEPLOY ALL" to confirm:',
          validate: (value) => value === 'DEPLOY ALL' || 'You must type DEPLOY ALL to confirm'
        });

        if (confirmText !== 'DEPLOY ALL') {
          logger.warn('Deploy cancelled');
          return;
        }

        for (const name of names) {
          const ctx = await buildCommandContext({ name, requireCredentials: false });
          const config = ctx.config;

          logger.title('OpenClaw AWS - Deploy');
          logger.info(`Deploying ${chalk.cyan(ctx.name)}`);

          await validatePreDeploy(config);
          console.log('');

          const statusSpinner = ora('Checking existing deployment...').start();
          try {
            const status = await getStackStatus(config.stack.name, config.aws.region);
            statusSpinner.succeed('Existing deployment found');
            logger.info(`Stack ${chalk.cyan(config.stack.name)} already exists (${status.stackStatus})`);
            console.log('');
            continue;
          } catch (error) {
            statusSpinner.stop();
            if (!(error instanceof Error && error.message.includes('not found'))) {
              throw error;
            }
          }

          // Show deployment plan
          logger.info('Deployment Plan:');
          console.log(`  Stack: ${chalk.cyan(config.stack.name)}`);
          console.log(`  Region: ${chalk.cyan(config.aws.region)}`);
          console.log(`  Instance: ${chalk.cyan(config.instance.type)} (${chalk.cyan(config.instance.name)})`);
          console.log(`  Resources:`);
          console.log(`    - EC2 Instance (${config.instance.type})`);
          console.log(`    - Security Group (no inbound rules)`);
          console.log(`    - IAM Role (SSM access only)`);

          // Get CDK binary (local from node_modules or global fallback)
          const cdkBinary = getCDKBinary();
          const cdkAppPath = path.resolve(__dirname, '../../cdk/app.js');

          const spinner = ora('Verifying CDK CLI...').start();
          try {
            await execa(cdkBinary, ['--version'], { reject: true });
            spinner.succeed('CDK CLI ready');
          } catch {
            spinner.fail('CDK CLI not available');
            throw new AWSError('AWS CDK CLI not available', [
              'Reinstall this package: npm install -g @salza80/openclaw-aws',
              'Or install CDK globally: npm install -g aws-cdk'
            ]);
          }

          const env = {
            ...ctx.awsEnv,
            OPENCLAW_CONFIG_NAME: ctx.name
          };

          spinner.start('Deploying stack... (this may take 3-5 minutes)');
          try {
            const outputsFile = resolveOutputsPath(ctx.name);
            await withRetry(
              async () => {
                await execa(cdkBinary, [
                  'deploy',
                  '--app', `node ${cdkAppPath}`,
                  '--require-approval', 'never',
                  '--outputs-file', outputsFile,
                  '--progress', 'events',
                ], { 
                  env,
                  cwd: process.cwd(),
                });
              },
              {
                maxAttempts: 2,
                delayMs: 5000,
                shouldRetry: (error) => {
                  return isRetryableError(error);
                },
                operationName: 'CDK deploy'
              }
            );

            spinner.succeed('Stack deployed successfully!');
          } catch (error) {
            spinner.fail('Deployment failed');
            throw error;
          }
        }

        return;
      }

      // Load and validate configuration
      const ctx = await buildCommandContext({ name: argv.name, requireCredentials: false });
      const config = ctx.config;
      
      logger.title('OpenClaw AWS - Deploy');
      logger.info(`Deploying ${chalk.cyan(ctx.name)}`);

      // Run pre-deployment validation
      await validatePreDeploy(config);

      // Check if stack already exists
      const statusSpinner = ora('Checking existing deployment...').start();
      try {
        const status = await getStackStatus(config.stack.name, config.aws.region);
        statusSpinner.succeed('Existing deployment found');
        logger.info(`Stack ${chalk.cyan(config.stack.name)} already exists (${status.stackStatus})`);
        console.log('\n' + chalk.bold('Next steps:'));
        console.log('  ' + chalk.cyan('openclaw-aws status') + '     - Check instance status');
        console.log('  ' + chalk.cyan('openclaw-aws connect') + '    - Connect via SSM');
        console.log('  ' + chalk.cyan('openclaw-aws dashboard') + '  - Access dashboard');
        return;
      } catch (error) {
        statusSpinner.stop();
        if (!(error instanceof Error && error.message.includes('not found'))) {
          throw error;
        }
      }

      console.log(''); // Empty line after validation

      // Show deployment plan
      logger.info('Deployment Plan:');
      console.log(`  Stack: ${chalk.cyan(config.stack.name)}`);
      console.log(`  Region: ${chalk.cyan(config.aws.region)}`);
      console.log(`  Instance: ${chalk.cyan(config.instance.type)} (${chalk.cyan(config.instance.name)})`);
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
          initial: true
        });

        if (!confirm) {
          logger.warn('Deployment cancelled');
          return;
        }
      }

      // Get CDK binary (local from node_modules or global fallback)
      const cdkBinary = getCDKBinary();

      // Get CDK app path
      const cdkAppPath = path.resolve(__dirname, '../../cdk/app.js');
      
      // Verify CDK is available
      const spinner = ora('Verifying CDK CLI...').start();
      try {
        await execa(cdkBinary, ['--version'], { reject: true });
        spinner.succeed('CDK CLI ready');
      } catch {
        spinner.fail('CDK CLI not available');
        throw new AWSError('AWS CDK CLI not available', [
          'Reinstall this package: npm install -g @salza80/openclaw-aws',
          'Or install CDK globally: npm install -g aws-cdk'
        ]);
      }
      
      // Set up environment
      const env = {
        ...ctx.awsEnv,
        OPENCLAW_CONFIG_NAME: ctx.name
      };

      // Deploy stack with retry logic
      spinner.start('Deploying stack... (this may take 3-5 minutes)');
      
      try {
        const outputsFile = resolveOutputsPath(ctx.name);
        
        await withRetry(
          async () => {
            await execa(cdkBinary, [
              'deploy',
              '--app', `node ${cdkAppPath}`,
              '--require-approval', 'never',
              '--outputs-file', outputsFile,
              '--progress', 'events',
            ], { 
              env,
              cwd: process.cwd(),
            });
          },
          {
            maxAttempts: 2,
            delayMs: 5000,
            shouldRetry: (error) => {
              // Only retry on network/throttling errors, not on validation errors
              return isRetryableError(error);
            },
            operationName: 'CDK deploy'
          }
        );

        spinner.succeed('Stack deployed successfully!');

        // Read and display outputs
        if (fs.existsSync(outputsFile)) {
          const outputs = JSON.parse(fs.readFileSync(outputsFile, 'utf-8'));
          const stackOutputs = outputs[config.stack.name] || {};

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
          console.log('  ' + chalk.cyan('1.') + ' Wait 10-15 minutes for OpenClaw installation');
          console.log('  ' + chalk.cyan('2.') + ' Check if ready: ' + chalk.yellow('openclaw-aws ready'));
          console.log('  ' + chalk.cyan('3.') + ' Check instance status: ' + chalk.yellow('openclaw-aws status'));
          console.log('  ' + chalk.cyan('4.') + ' When ready, run: ' + chalk.yellow('openclaw-aws onboard'));
          console.log('  ' + chalk.cyan('5.') + ' Access dashboard: ' + chalk.yellow('openclaw-aws dashboard'));
          
          console.log('\n' + chalk.gray('💡 Tip: Use ') + chalk.cyan('openclaw-aws ready --watch') + chalk.gray(' to monitor installation progress'));
        }

      } catch (error) {
        spinner.fail('Deployment failed');
        throw error;
      }

    } catch (error) {
      handleError(error);
    }
  },
};

export default deployCommand;
