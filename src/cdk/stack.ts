import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { 
  Instance, 
  InstanceType, 
  InstanceClass, 
  InstanceSize, 
  AmazonLinuxImage, 
  AmazonLinuxGeneration, 
  SecurityGroup, 
  UserData, 
  SubnetType, 
  Vpc,
  HttpTokens,
} from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import type { StackConfig } from '../cli/types/index.js';

export class OpenClawStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    config: StackConfig,
    props?: StackProps
  ) {
    super(scope, id, props);

    // Use default VPC
    const vpc = Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // Security group: allow only SSM and all outbound
    const sg = new SecurityGroup(this, 'OpenClawEc2Sg', {
      vpc,
      description: 'Allow SSM only, all outbound',
      allowAllOutbound: true,
    });
    // No inbound rules (SSM does not require any)

    // IAM role for SSM
    const role = new Role(this, 'OpenClawEc2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Determine AMI and package manager based on config
    const isAL2023 = config.amiType === 'amazon-linux-2023';
    const amiGeneration = isAL2023 
      ? AmazonLinuxGeneration.AMAZON_LINUX_2023 
      : AmazonLinuxGeneration.AMAZON_LINUX_2;
    const pkgManager = isAL2023 ? 'dnf' : 'yum';

    // UserData script to install Node.js and OpenClaw CLI
    // Note: Onboarding must be done manually via SSM (requires interactive input)
    const userData = UserData.forLinux();
    
    // Use sequential installation (not background) for reliability
    userData.addCommands(
      // Update system
      `sudo systemctl enable amazon-ssm-agent`,
      `sudo systemctl start amazon-ssm-agent`,
      `sleep 10`,  // Give SSM Agent time to start
  
      `${pkgManager} update -y`,
      `${pkgManager} install -y nodejs22 git`,
      `curl -fsSL https://openclaw.ai/install.sh | bash -`,
      // Install Node.js 22 via NodeSource
      //`${pkgManager} install -y nodejs22 git`,
      // Install OpenClaw CLI
      // 'npm install -g openclaw@latest',
      // 'npm list -g openclaw || exit 1',
      
      // // Create marker file to indicate completion
      'touch /tmp/openclaw-ready',
      
      // // Create setup instructions
      'echo "OpenClaw CLI installed successfully. Connect via SSM to run: openclaw onboard --install-daemon" > /home/ec2-user/SETUP_INSTRUCTIONS.txt',
      'chown ec2-user:ec2-user /home/ec2-user/SETUP_INSTRUCTIONS.txt',
      
      // // Log completion
      'echo "$(date): OpenClaw installation completed" > /var/log/openclaw-install.log'
    );

    // Parse instance type from config
    const instanceClass = InstanceClass[config.instanceType.class as keyof typeof InstanceClass];
    const instanceSize = InstanceSize[config.instanceType.size as keyof typeof InstanceSize];

    // EC2 instance
    const instance = new Instance(this, 'OpenClawEc2', {
      vpc,
      instanceType: InstanceType.of(instanceClass, instanceSize),
      machineImage: new AmazonLinuxImage({ generation: amiGeneration }),
      securityGroup: sg,
      role,
      userData,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });

    // Add tags for easy identification
    instance.instance.addPropertyOverride('Tags', [
      { Key: 'Name', Value: config.instanceName },
      { Key: 'Project', Value: config.projectName },
      { Key: 'ManagedBy', Value: 'openclaw-aws' }
    ]);

    // Outputs for easy connection
    new CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID for SSM connection',
      exportName: `${id}-InstanceId`
    });

    new CfnOutput(this, 'InstanceName', {
      value: config.instanceName,
      description: 'EC2 Instance Name'
    });

    new CfnOutput(this, 'SSMConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${Stack.of(this).region}`,
      description: 'Command to connect via SSM'
    });

    new CfnOutput(this, 'SSMPortForwardCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=18789,localPortNumber=18789" --region ${Stack.of(this).region}`,
      description: 'Command to forward dashboard port (run this to access OpenClaw dashboard at http://localhost:18789)'
    });
  }
}
