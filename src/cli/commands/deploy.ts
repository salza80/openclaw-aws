import type { CommandModule } from 'yargs';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { loadConfig, getConfigDir, getOutputsPath } from '../utils/config.js';
import { handleError, AWSError, withRetry, isRetryableError } from '../utils/errors.js';
import { validatePreDeploy, validateNodeVersion } from '../utils/aws-validation.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import prompts from 'prompts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DeployArgs {
  autoApprove?: boolean;
  config?: string;
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
      .option('config', {
        type: 'string',
        describe: 'Path to config file',
      });
  },
  
  handler: async (argv) => {
    try {
      // Validate Node version
      validateNodeVersion();

      // Load and validate configuration
      const config = loadConfig(argv.config);
      
      logger.title('OpenClaw AWS - Deploy');

      // Run pre-deployment validation
      await validatePreDeploy(config);

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
      console.log(`    - UserData (Node.js ${config.instance.nodeVersion} + OpenClaw CLI)`);

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

      // Check for CDK CLI
      const spinner = ora('Checking CDK CLI...').start();
      try {
        await execa('cdk', ['--version']);
        spinner.succeed('CDK CLI found');
      } catch {
        spinner.fail('CDK CLI not found');
        throw new AWSError('AWS CDK CLI not found', [
          'Install: npm install -g aws-cdk',
          'Or with homebrew: brew install aws-cdk'
        ]);
      }

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

      // Deploy stack with retry logic
      spinner.start('Deploying stack... (this may take 3-5 minutes)');
      
      try {
        const outputsFile = getOutputsPath();
        
        await withRetry(
          async () => {
            await execa('cdk', [
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
          console.log('  ' + chalk.cyan('1.') + ' Wait 2-3 minutes for instance to initialize');
          console.log('  ' + chalk.cyan('2.') + ' Run: ' + chalk.yellow('openclaw-aws onboard'));
          console.log('  ' + chalk.cyan('3.') + ' Access dashboard: ' + chalk.yellow('openclaw-aws dashboard'));
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
