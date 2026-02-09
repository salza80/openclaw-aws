import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import { EC2Client } from '@aws-sdk/client-ec2';

export function createCloudFormationClient(region: string): CloudFormationClient {
  return new CloudFormationClient({ region });
}

export function createSsmClient(region: string): SSMClient {
  return new SSMClient({ region });
}

export function createEc2Client(region: string): EC2Client {
  return new EC2Client({ region });
}
