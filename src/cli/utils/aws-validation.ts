import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import ora from 'ora';
import { ValidationError, AWSError, withRetry } from './errors.js';
import type { OpenClawConfig } from '../types/index.js';

export interface AWSCredentials {
  account: string;
  userId: string;
  arn: string;
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
      'Run: aws configure',
      'Check your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      'Verify your AWS credentials file: ~/.aws/credentials'
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

export async function checkCDKBootstrap(account: string, region: string): Promise<boolean> {
  try {
    const client = new CloudFormationClient({ region });
    const command = new DescribeStacksCommand({
      StackName: 'CDKToolkit'
    });
    
    await client.send(command);
    return true;
  } catch (error) {
    return false;
  }
}

export async function validatePreDeploy(config: OpenClawConfig): Promise<void> {
  const spinner = ora('Running pre-deployment validation...').start();
  
  try {
    // 1. Validate AWS credentials
    spinner.text = 'Validating AWS credentials...';
    const credentials = await validateAWSCredentials(config.aws.region);
    spinner.succeed(`AWS credentials validated (Account: ${credentials.account})`);
    
    // 2. Validate AWS region
    spinner.start('Validating AWS region...');
    await validateAWSRegion(config.aws.region);
    spinner.succeed(`AWS region validated (${config.aws.region})`);
    
    // 3. Check CDK bootstrap
    spinner.start('Checking CDK bootstrap...');
    const isBootstrapped = await checkCDKBootstrap(credentials.account, config.aws.region);
    
    if (!isBootstrapped) {
      spinner.warn('CDK not bootstrapped in this region');
      throw new ValidationError('CDK bootstrap required', [
        `Run: cdk bootstrap aws://${credentials.account}/${config.aws.region}`,
        'This is a one-time setup per account/region',
        'Learn more: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html'
      ]);
    }
    
    spinner.succeed('CDK bootstrap verified');
    
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
