import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';

export class MoltbotawsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Example S3 bucket resource
    new Bucket(this, 'MoltbotawsBucket', {
      versioned: true,
      removalPolicy: undefined, // Set to cdk.RemovalPolicy.DESTROY for dev/test
      autoDeleteObjects: false,
    });
  }
}
