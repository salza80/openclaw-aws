import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import ora from 'ora';
import prompts from 'prompts';
import chalk from 'chalk';
import { ValidationError, AWSError, withRetry } from './errors.js';
import type { OpenClawConfig } from '../types/index.js';

export interface AWSCredentials {
  account: string;
  userId: string;
  arn: string;
}

export function applyAwsProfile(profile?: string): void {
  if (!profile) return;
  process.env.AWS_PROFILE = profile;
  process.env.AWS_SDK_LOAD_CONFIG = '1';
}

export async function requireAwsCredentials(config: OpenClawConfig): Promise<AWSCredentials> {
  applyAwsProfile(config.aws.profile);
  return validateAWSCredentials(config.aws.region);
}

export async function validateAWSCredentials(region: string): Promise<AWSCredentials> {
  try {
    const client = new STSClient({ region });
    const command = new GetCallerIdentityCommand({});
    
    const response = await withRetry(
      async () => await client.send(command),
      {
        maxAttempts: 3,
        operationName: 'validate AWS credentials'
      }
    );
    
    if (!response.Account || !response.UserId || !response.Arn) {
      throw new AWSError('Invalid AWS credentials response', [
        'Run: aws configure',
        'Check your AWS credentials are properly set'
      ]);
    }
    
    return {
      account: response.Account,
      userId: response.UserId,
      arn: response.Arn
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof AWSError) {
      throw error;
    }
    
    throw new AWSError('Failed to validate AWS credentials', [
      'Session expired? Re-authenticate: aws sso login',
      'First-time setup (IAM Identity Center/SSO): aws configure sso',
      'Using access keys? Configure the AWS CLI: aws configure',
      'Check env vars: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      'Check credentials file: ~/.aws/credentials'
    ]);
  }
}

export async function validateAWSRegion(region: string): Promise<boolean> {
  try {
    const client = new EC2Client({ region });
    const command = new DescribeRegionsCommand({
      RegionNames: [region]
    });
    
    await client.send(command);
    return true;
  } catch (error) {
    throw new ValidationError(`Invalid AWS region: ${region}`, [
      'Check available regions: aws ec2 describe-regions',
      'Common regions: us-east-1, us-west-2, eu-west-1'
    ]);
  }
}

/**
 * Get the current CDK bootstrap version from CloudFormation.
 * Returns the version number or null if not bootstrapped.
 */
export async function getCDKBootstrapVersion(region: string): Promise<number | null> {
  try {
    const client = new CloudFormationClient({ region });
    const command = new DescribeStacksCommand({
      StackName: 'CDKToolkit'
    });
    
    const response = await client.send(command);
    const stack = response.Stacks?.[0];
    
    if (!stack) return null;
    
    // Find BootstrapVersion output
    const versionOutput = stack.Outputs?.find(
      output => output.OutputKey === 'BootstrapVersion'
    );
    
    if (!versionOutput?.OutputValue) return null;
    
    return parseInt(versionOutput.OutputValue, 10);
  } catch (error) {
    return null; // Not bootstrapped
  }
}

/**
 * Check if CDK is bootstrapped and meets minimum version requirement.
 * Returns an object with bootstrap status, version, and minimum version check.
 */
export async function checkCDKBootstrap(
  account: string,
  region: string,
  minVersion: number = 30
): Promise<{
  bootstrapped: boolean;
  version: number | null;
  meetsMinimum: boolean;
}> {
  const version = await getCDKBootstrapVersion(region);
  
  return {
    bootstrapped: version !== null,
    version,
    meetsMinimum: version !== null && version >= minVersion
  };
}

/**
 * Run CDK bootstrap for the specified account and region.
 * Uses the bundled CDK version to ensure compatibility.
 */
export async function runCDKBootstrap(
  account: string,
  region: string,
  profile?: string
): Promise<void> {
  const { execa } = await import('execa');
  const { getCDKBinary } = await import('./cdk.js');
  
  const cdkBinary = getCDKBinary();
  const envQualifier = `aws://${account}/${region}`;
  
  const env: Record<string, string | undefined> = {
    ...process.env,
    AWS_REGION: region,
  };

  if (profile) {
    env.AWS_PROFILE = profile;
  }
  
  try {
    await execa(cdkBinary, [
      'bootstrap',
      envQualifier,
    ], {
      env,
      stdio: 'inherit' // Show CDK output to user
    });
  } catch (error) {
    throw new AWSError('Failed to bootstrap CDK', [
      `Tried: ${cdkBinary} bootstrap ${envQualifier}`,
      'Check AWS permissions (CloudFormation, S3, IAM required)',
      'Learn more: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html'
    ]);
  }
}

export async function validatePreDeploy(config: OpenClawConfig): Promise<void> {
  const spinner = ora('Running pre-deployment validation...').start();
  
  try {
    // 1. Validate AWS credentials
    spinner.text = 'Validating AWS credentials...';
    const credentials = await requireAwsCredentials(config);
    spinner.succeed(`AWS credentials validated (Account: ${credentials.account})`);
    
    // 2. Validate AWS region
    spinner.start('Validating AWS region...');
    await validateAWSRegion(config.aws.region);
    spinner.succeed(`AWS region validated (${config.aws.region})`);
    
    // 3. Check CDK bootstrap
    spinner.start('Checking CDK bootstrap...');
    const bootstrapStatus = await checkCDKBootstrap(credentials.account, config.aws.region);
    
    if (!bootstrapStatus.meetsMinimum) {
      spinner.warn(
        bootstrapStatus.bootstrapped 
          ? `CDK bootstrap version ${bootstrapStatus.version} is outdated (requires v30+)`
          : 'CDK not bootstrapped in this region'
      );
      
      console.log(''); // Empty line
      
      // Explain what bootstrap does (concise)
      if (!bootstrapStatus.bootstrapped) {
        console.log(chalk.dim('CDK bootstrap sets up required AWS resources (S3 bucket, IAM roles) for deployments.'));
        console.log(chalk.dim('This is a one-time setup per account/region.'));
      } else {
        console.log(chalk.dim('Your CDK bootstrap version needs to be upgraded to support the latest CDK features.'));
      }
      
      console.log(''); // Empty line
      
      // Prompt user to run bootstrap
      const { runBootstrap } = await prompts({
        type: 'confirm',
        name: 'runBootstrap',
        message: bootstrapStatus.bootstrapped 
          ? 'Upgrade CDK bootstrap now? (Recommended)'
          : 'Run CDK bootstrap now? (Recommended)',
        initial: true
      });
      
      if (!runBootstrap) {
        throw new ValidationError('CDK bootstrap required', [
          `Run manually: npx cdk bootstrap aws://${credentials.account}/${config.aws.region}`,
          'Learn more: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html'
        ]);
      }
      
      // Run bootstrap
      console.log(''); // Empty line
      spinner.start('Bootstrapping CDK... (this may take 1-2 minutes)');
      
      try {
        await runCDKBootstrap(credentials.account, config.aws.region, config.aws.profile);
        spinner.succeed('CDK bootstrap completed successfully');
        
        // Verify the bootstrap worked and version is correct
        spinner.start('Verifying bootstrap...');
        const verifyStatus = await checkCDKBootstrap(credentials.account, config.aws.region);
        
        if (!verifyStatus.meetsMinimum) {
          spinner.fail('Bootstrap verification failed');
          throw new ValidationError('CDK bootstrap verification failed', [
            `Expected version 30+, got ${verifyStatus.version}`,
            'Try running manually: npx cdk bootstrap aws://${credentials.account}/${config.aws.region}',
          ]);
        }
        
        spinner.succeed(`CDK bootstrap verified (v${verifyStatus.version})`);
      } catch (error) {
        spinner.fail('CDK bootstrap failed');
        throw error;
      }
    } else {
      spinner.succeed(`CDK bootstrap verified (v${bootstrapStatus.version})`);
    }
    
    // 4. Validate instance type format
    spinner.start('Validating configuration...');
    validateInstanceType(config.instance.type);
    spinner.succeed('Configuration validated');
    
  } catch (error) {
    spinner.fail('Validation failed');
    throw error;
  }
}

export function validateInstanceType(instanceType: string): void {
  const validPattern = /^[a-z][0-9][a-z]?\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/;
  
  if (!validPattern.test(instanceType)) {
    throw new ValidationError(`Invalid instance type: ${instanceType}`, [
      'Format should be: family.size (e.g., t3.micro)',
      'Valid examples: t3.micro, t3.small, t3.medium, m5.large'
    ]);
  }
}

export async function validateStackExists(stackName: string, region: string): Promise<boolean> {
  try {
    const client = new CloudFormationClient({ region });
    const command = new DescribeStacksCommand({ StackName: stackName });
    
    await client.send(command);
    return true;
  } catch (error) {
    return false;
  }
}

export function validateNodeVersion(): void {
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
  
  if (majorVersion < 18) {
    throw new ValidationError(
      `Node.js version ${nodeVersion} is not supported. Requires Node.js 18 or higher.`,
      [
        'Install Node.js 18 or higher from https://nodejs.org/',
        'Or use nvm: nvm install 22 && nvm use 22'
      ]
    );
  }
}

export async function validateSSMPlugin(): Promise<void> {
  const { execa } = await import('execa');
  
  try {
    await execa('session-manager-plugin', ['--version']);
  } catch (error) {
    throw new ValidationError('AWS Session Manager plugin not found', [
      'Install from: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
      'macOS: brew install --cask session-manager-plugin',
      'Ubuntu: Download and install .deb package'
    ]);
  }
}
