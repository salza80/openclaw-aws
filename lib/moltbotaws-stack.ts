import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Instance, InstanceType, InstanceClass, InstanceSize, AmazonLinuxImage, AmazonLinuxGeneration, SecurityGroup, UserData, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';

export class MoltbotawsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Use default VPC
    const vpc = Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // Security group: allow only SSM and all outbound
    const sg = new SecurityGroup(this, 'MoltbotEc2Sg', {
      vpc,
      description: 'Allow SSM only, all outbound',
      allowAllOutbound: true,
    });
    // No inbound rules (SSM does not require any)

    // IAM role for SSM
    const role = new Role(this, 'MoltbotEc2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // UserData script to install Node.js and OpenClaw CLI
    // Note: Onboarding must be done manually via SSM (requires interactive input)
    const userData = UserData.forLinux();
    userData.addCommands(
      'dnf update -y',
      'dnf install -y nodejs22 git',  // Install Node.js 22 and git
      'npm install -g openclaw@latest',  // Install OpenClaw
      'echo "Ready" > /tmp/openclaw-ready'
    );

    // EC2 instance
    const instance = new Instance(this, 'MoltbotEc2', {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      machineImage: new AmazonLinuxImage({ generation: AmazonLinuxGeneration.AMAZON_LINUX_2023 }),
      securityGroup: sg,
      role,
      userData,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });

    // Add a name tag for easy identification in SSM
    instance.instance.addPropertyOverride('Tags', [
      { Key: 'Name', Value: 'moltbot-openclaw' }
    ]);

    // Outputs for easy connection
    new CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID for SSM connection',
      exportName: 'MoltbotInstanceId'
    });

    new CfnOutput(this, 'SSMConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId}`,
      description: 'Command to connect via SSM'
    });

    new CfnOutput(this, 'SSMPortForwardCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=18789,localPortNumber=18789"`,
      description: 'Command to forward dashboard port (run this to access OpenClaw dashboard at http://localhost:18789)'
    });
  }
}