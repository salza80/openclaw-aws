import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  EC2Client,
  DescribeRegionsCommand,
  DescribeInstanceTypesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import ora from 'ora';
import prompts from 'prompts';
import chalk from 'chalk';
import { ValidationError, AWSError, withRetry } from './errors.js';
import { awsCredentialSuggestions } from './suggestions.js';
import type { OpenClawConfig } from '../types/index.js';
import { MIN_NODE_VERSION } from '../constants.js';
import { applyAwsProfile } from './aws-profile.js';

export { applyAwsProfile } from './aws-profile.js';

export interface AWSCredentials {
  account: string;
  userId: string;
  arn: string;
}

export async function requireAwsCredentials(config: OpenClawConfig): Promise<AWSCredentials> {
  applyAwsProfile(config.aws.profile);
  return validateAWSCredentials(config.aws.region);
}

export async function validateAWSCredentials(region: string): Promise<AWSCredentials> {
  const client = new STSClient({ region });
  try {
    const command = new GetCallerIdentityCommand({});

    const response = await withRetry(async () => await client.send(command), {
      maxAttempts: 3,
      operationName: 'validate AWS credentials',
    });

    if (!response.Account || !response.UserId || !response.Arn) {
      throw new AWSError('Invalid AWS credentials response', [
        'Run: aws configure',
        'Check your AWS credentials are properly set',
      ]);
    }

    return {
      account: response.Account,
      userId: response.UserId,
      arn: response.Arn,
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof AWSError) {
      throw error;
    }

    throw new AWSError('Failed to validate AWS credentials', [...awsCredentialSuggestions()]);
  } finally {
    client.destroy();
  }
}

export async function validateAWSRegion(region: string): Promise<boolean> {
  const client = new EC2Client({ region });
  try {
    const command = new DescribeRegionsCommand({
      RegionNames: [region],
    });

    await client.send(command);
    return true;
  } catch {
    throw new ValidationError(`Invalid AWS region: ${region}`, [
      'Check available regions: aws ec2 describe-regions',
      'Common regions: us-east-1, us-west-2, eu-west-1',
    ]);
  } finally {
    client.destroy();
  }
}

/** Verify new-host requirements against AWS metadata rather than a family whitelist. */
export async function validateInstanceCapabilities(
  instanceType: string,
  region: string,
): Promise<void> {
  validateInstanceType(instanceType);
  const client = new EC2Client({ region });
  try {
    let response;
    try {
      response = await client.send(
        new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as _InstanceType] }),
      );
    } catch (error) {
      const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const failure = new AWSError(
        `Unable to verify EC2 instance type '${instanceType}' in '${region}': ${details}`,
        [
          'Allow ec2:DescribeInstanceTypes for the deployment credentials',
          'Check the instance type, AWS credentials, and connectivity to the regional EC2 API',
        ],
      );
      failure.cause = error;
      throw failure;
    }

    const matches = response.InstanceTypes?.filter((item) => item.InstanceType === instanceType);
    if (matches?.length !== 1) {
      throw new ValidationError(
        `AWS did not return unambiguous metadata for EC2 instance type '${instanceType}' in '${region}'`,
        ['Choose an instance type available in this AWS region and retry'],
      );
    }

    const memoryMiB = matches[0].MemoryInfo?.SizeInMiB;
    const architectures = matches[0].ProcessorInfo?.SupportedArchitectures;
    if (
      !Number.isSafeInteger(memoryMiB) ||
      !memoryMiB ||
      memoryMiB <= 0 ||
      !architectures?.length
    ) {
      throw new ValidationError(
        `AWS returned incomplete memory or architecture metadata for EC2 instance type '${instanceType}'`,
        ['Retry the EC2 instance type lookup before creating deployment resources'],
      );
    }
    if (!architectures.includes('x86_64')) {
      throw new ValidationError(
        `EC2 instance type '${instanceType}' does not support x86_64 (${architectures.join(', ')})`,
        ['Choose an x86_64 instance type; the Ubuntu AMI and bootstrap packages require x86_64'],
      );
    }
    if (memoryMiB < 1024) {
      throw new ValidationError(
        `EC2 instance type '${instanceType}' has ${memoryMiB} MiB RAM; OpenClaw requires at least 1024 MiB (1 GiB)`,
        ['Choose an instance type with at least 1 GiB RAM; 2 GiB or more is recommended'],
      );
    }
  } finally {
    client.destroy();
  }
}

/**
 * Get the current CDK bootstrap version from CloudFormation.
 * Returns the version number or null if not bootstrapped.
 */
export async function getCDKBootstrapVersion(region: string): Promise<number | null> {
  const client = new CloudFormationClient({ region });
  try {
    const command = new DescribeStacksCommand({
      StackName: 'CDKToolkit',
    });

    const response = await client.send(command);
    const stack = response.Stacks?.[0];

    if (!stack) return null;

    // Find BootstrapVersion output
    const versionOutput = stack.Outputs?.find((output) => output.OutputKey === 'BootstrapVersion');

    if (!versionOutput?.OutputValue) return null;

    return parseInt(versionOutput.OutputValue, 10);
  } catch {
    return null; // Not bootstrapped
  } finally {
    client.destroy();
  }
}

/**
 * Check if CDK is bootstrapped and meets minimum version requirement.
 * Returns an object with bootstrap status, version, and minimum version check.
 */
export async function checkCDKBootstrap(
  account: string,
  region: string,
  minVersion: number = 30,
): Promise<{
  bootstrapped: boolean;
  version: number | null;
  meetsMinimum: boolean;
}> {
  const version = await getCDKBootstrapVersion(region);

  return {
    bootstrapped: version !== null,
    version,
    meetsMinimum: version !== null && version >= minVersion,
  };
}

/**
 * Run CDK bootstrap for the specified account and region.
 * Uses the bundled CDK version to ensure compatibility.
 */
export async function runCDKBootstrap(
  account: string,
  region: string,
  profile?: string,
): Promise<void> {
  const { execa } = await import('execa');
  const { getCDKBinary } = await import('./cdk.js');

  const cdkBinary = getCDKBinary();
  const envQualifier = `aws://${account}/${region}`;

  const env: Record<string, string | undefined> = {
    ...process.env,
    AWS_REGION: region,
    CDK_DISABLE_VERSION_CHECK: 'true',
    CDK_DISABLE_CLI_TELEMETRY: '1',
    CI: 'true',
  };

  if (profile) {
    env.AWS_PROFILE = profile;
  }

  try {
    await execa(cdkBinary, ['bootstrap', '--no-notices', '--no-version-reporting', envQualifier], {
      env,
      stdio: 'inherit', // Show CDK output to user
    });
  } catch {
    throw new AWSError('Failed to bootstrap CDK', [
      `Tried: ${cdkBinary} bootstrap ${envQualifier}`,
      'Check AWS permissions (CloudFormation, S3, IAM required)',
      'Learn more: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html',
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

    // 3. Reject unsupported hosts before CDK bootstrap can create any resources.
    spinner.start('Validating EC2 instance capabilities...');
    await validateInstanceCapabilities(config.instance.type, config.aws.region);
    spinner.succeed('EC2 instance capabilities validated');

    // 4. Check CDK bootstrap
    spinner.start('Checking CDK bootstrap...');
    const bootstrapStatus = await checkCDKBootstrap(credentials.account, config.aws.region);

    if (!bootstrapStatus.meetsMinimum) {
      spinner.warn(
        bootstrapStatus.bootstrapped
          ? `CDK bootstrap version ${bootstrapStatus.version} is outdated (requires v30+)`
          : 'CDK not bootstrapped in this region',
      );

      console.log(''); // Empty line

      // Explain what bootstrap does (concise)
      if (!bootstrapStatus.bootstrapped) {
        console.log(
          chalk.dim(
            'CDK bootstrap sets up required AWS resources (S3 bucket, IAM roles) for deployments.',
          ),
        );
        console.log(chalk.dim('This is a one-time setup per account/region.'));
      } else {
        console.log(
          chalk.dim(
            'Your CDK bootstrap version needs to be upgraded to support the latest CDK features.',
          ),
        );
      }

      console.log(''); // Empty line

      // Prompt user to run bootstrap
      const { runBootstrap } = await prompts({
        type: 'confirm',
        name: 'runBootstrap',
        message: bootstrapStatus.bootstrapped
          ? 'Upgrade CDK bootstrap now? (Recommended)'
          : 'Run CDK bootstrap now? (Recommended)',
        initial: true,
      });

      if (!runBootstrap) {
        throw new ValidationError('CDK bootstrap required', [
          `Run manually: npx cdk bootstrap aws://${credentials.account}/${config.aws.region}`,
          'Learn more: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html',
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
            `Try running manually: npx cdk bootstrap aws://${credentials.account}/${config.aws.region}`,
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
      'Valid examples: t3.micro, t3.small, t3.medium, m5.large',
    ]);
  }
}

export async function validateStackExists(stackName: string, region: string): Promise<boolean> {
  const client = new CloudFormationClient({ region });
  try {
    const command = new DescribeStacksCommand({ StackName: stackName });

    await client.send(command);
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

export function validateNodeVersion(): void {
  const nodeVersion = process.version;
  const current = nodeVersion.substring(1).split('.').map(Number);
  const minimum = MIN_NODE_VERSION.split('.').map(Number);
  const firstDifference = current.findIndex((part, index) => part !== minimum[index]);

  if (firstDifference !== -1 && current[firstDifference] < minimum[firstDifference]) {
    throw new ValidationError(
      `Node.js version ${nodeVersion} is not supported. Requires Node.js ${MIN_NODE_VERSION} or higher.`,
      [
        `Install Node.js ${MIN_NODE_VERSION} or higher from https://nodejs.org/`,
        'Or use nvm in this project: nvm install && nvm use',
      ],
    );
  }
}

export async function validateSSMPlugin(): Promise<void> {
  const { execa } = await import('execa');

  try {
    await execa('session-manager-plugin', ['--version']);
  } catch {
    throw new ValidationError('AWS Session Manager plugin not found', [
      'Install from: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
      'macOS: brew install --cask session-manager-plugin',
      'Ubuntu: Download and install .deb package',
    ]);
  }
}
