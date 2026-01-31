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
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  GatewayVpcEndpoint,
  GatewayVpcEndpointAwsService
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
    // Run installations in background to avoid blocking SSM Session Manager
    const userData = UserData.forLinux();
    
    userData.addCommands(
      // Quick system update (don't block SSM)
      `${pkgManager} update -y`,
      
      // Ensure SSM agent is running (AL2023 specific)
      'systemctl enable amazon-ssm-agent',
      'systemctl start amazon-ssm-agent',
      
      // Run heavy installations in background to not block SSM
      // This allows SSM sessions to connect while installation continues
      `nohup bash -c '
        # Install Node.js 22 via NodeSource
        curl -fsSL https://rpm.nodesource.com/setup_${config.nodeVersion}.x | bash -
        ${pkgManager} install -y nodejs git
        
        # Install OpenClaw CLI
        npm install -g openclaw@latest
        
        # Create completion markers
        echo "OpenClaw CLI installed successfully. Connect via SSM to run: openclaw onboard --install-daemon" > /home/ec2-user/SETUP_INSTRUCTIONS.txt
        chown ec2-user:ec2-user /home/ec2-user/SETUP_INSTRUCTIONS.txt
        echo "READY" > /tmp/openclaw-install-complete
        
        # Log completion
        echo "$(date): OpenClaw installation completed" >> /var/log/openclaw-setup.log
      ' > /var/log/openclaw-setup.log 2>&1 &`,
      
      // Leave a note that installation is running in background
      'echo "OpenClaw installation running in background. Check progress: tail -f /var/log/openclaw-setup.log" > /home/ec2-user/README.txt',
      'chown ec2-user:ec2-user /home/ec2-user/README.txt'
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
