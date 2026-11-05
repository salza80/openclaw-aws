import { awsClientConfig, type AwsLocation } from '../../aws/target.js';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import { EC2Client } from '@aws-sdk/client-ec2';

export function createCloudFormationClient(region: AwsLocation): CloudFormationClient {
  return new CloudFormationClient(awsClientConfig(region));
}

export function createSsmClient(region: AwsLocation): SSMClient {
  return new SSMClient(awsClientConfig(region));
}

export function createEc2Client(region: AwsLocation): EC2Client {
  return new EC2Client(awsClientConfig(region));
}
