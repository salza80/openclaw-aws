import { Stack, StackProps, CfnOutput, Token } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { 
  Instance, 
  InstanceType, 
  InstanceClass, 
  InstanceSize,
  MachineImage,
  SecurityGroup, 
  UserData, 
  SubnetType, 
  Vpc,
  IVpc,
  Peer,
  Port,
  CfnKeyPair,
} from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter, ParameterTier, ParameterType } from 'aws-cdk-lib/aws-ssm';
import * as crypto from 'crypto';
import type { StackConfig } from '../cli/types/index.js';

export interface OpenClawStackProps extends StackProps {
  config: StackConfig;
  apiProvider: 'anthropic' | 'openrouter' | 'openai' | 'custom';
  apiKey: string;
  gatewayPort?: number;
  browserPort?: number;
  customApiBaseUrl?: string;
  useDefaultVpc: boolean;
}

export class OpenClawStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenClawStackProps) {
    super(scope, id, props);

    const { config, apiProvider, apiKey } = props;
    const gatewayPort = props.gatewayPort ?? 18789;
    const browserPort = props.browserPort ?? 18791;

    // Generate gateway token (deterministic from stack ID for reproducibility)
    const gatewayToken = crypto
      .createHash('sha256')
      .update(`${Stack.of(this).stackId}-${Stack.of(this).region}`)
      .digest('hex')
      .substring(0, 48);

    // VPC Configuration - Use default or create new based on config
    let vpc: IVpc;
    if (props.useDefaultVpc) {
      // Use default VPC (exists in every AWS account)
      vpc = Vpc.fromLookup(this, 'DefaultVpc', {
        isDefault: true,
      });
    } else {
      // Create new dedicated VPC with public subnet
      vpc = new Vpc(this, 'OpenClawVpc', {
        cidr: '10.0.0.0/16',
        maxAzs: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'Public',
            subnetType: SubnetType.PUBLIC,
          },
        ],
        natGateways: 0,
      });
    }

    // Security group - SSM access only (no inbound ports)
    const sg = new SecurityGroup(this, 'OpenClawEc2Sg', {
      vpc,
      description: 'Security group for OpenClaw instance - SSM access only, no inbound ports',
      allowAllOutbound: true,
    });

    // IAM role for SSM and optionally CloudWatch
    const managedPolicies = [
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    ];
    
    // Conditionally add CloudWatch policy if enabled
    if (config.enableCloudWatchLogs) {
      managedPolicies.push(
        ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy')
      );
    }
    
    const role = new Role(this, 'OpenClawEc2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies,
    });

    // Store API key in Parameter Store (SecureString for encryption)
    const apiKeyParameter = new StringParameter(this, 'ApiKeyParameter', {
      parameterName: `/openclaw/${Stack.of(this).stackName}/api-key`,
      stringValue: apiKey,
      description: `API key for OpenClaw instance (${apiProvider})`,
      tier: ParameterTier.ADVANCED,
      type: ParameterType.SECURE_STRING,
    });

    // Grant EC2 instance permission to read the parameter
    apiKeyParameter.grantRead(role);

    // Generate SSH key pair
    const keyPair = new CfnKeyPair(this, 'OpenClawKeyPair', {
      keyName: `${Stack.of(this).stackName}-key`,
      keyType: 'ed25519',
    });

    // Determine AMI - Ubuntu 24.04 LTS
    const ami = MachineImage.lookup({
      name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
      owners: ['099720109477'], // Canonical
    });

    // UserData script - simplified without Tailscale
    const userData = UserData.forLinux();
    
    // Set appropriate environment variable based on API provider
    const apiKeyEnvVar = apiProvider === 'anthropic' 
      ? 'ANTHROPIC_API_KEY' 
      : apiProvider === 'openrouter'
      ? 'OPENROUTER_API_KEY'
      : apiProvider === 'openai'
      ? 'OPENAI_API_KEY'
      : 'CUSTOM_API_KEY';
    
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      '',
      'export DEBIAN_FRONTEND=noninteractive',
      '',
      '# System updates',
      'apt-get update',
      'apt-get upgrade -y',
      '',
      '# Check if SSM Agent is already installed (Ubuntu 24.04 has it pre-installed via snap)',
      'if ! systemctl is-active --quiet snap.amazon-ssm-agent.amazon-ssm-agent.service && ! systemctl is-active --quiet amazon-ssm-agent; then',
      '  echo "Installing SSM Agent..."',
      '  curl -fsSL https://amazon-ssm-us-east-1.s3.us-east-1.amazonaws.com/latest/debian_amd64/amazon-ssm-agent.deb -o /tmp/amazon-ssm-agent.deb || curl -fsSL https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/debian_amd64/amazon-ssm-agent.deb -o /tmp/amazon-ssm-agent.deb',
      '  dpkg -i /tmp/amazon-ssm-agent.deb || true',
      '  systemctl enable amazon-ssm-agent || true',
      '  systemctl start amazon-ssm-agent || true',
      'else',
      '  echo "SSM Agent already installed"',
      'fi',
      '',
      '# Install required packages',
      'apt-get install -y curl git python3 python3-pip jq wget snapd',
      '',
      '# Install Docker',
      'curl -fsSL https://get.docker.com | sh',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ubuntu',
      '',
      '# Install NVM and Node.js for ubuntu user',
      'sudo -u ubuntu bash << \'UBUNTU_SCRIPT\'',
      'set -e',
      'cd ~',
      '',
      '# Install NVM',
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash',
      '',
      '# Load NVM',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      '',
      '# Install Node.js 22',
      'nvm install 22',
      'nvm use 22',
      'nvm alias default 22',
      '',
      '# Install OpenClaw',
      'npm install -g openclaw@latest',
      '',
      '# Install Homebrew (non-interactive, no sudo required)',
      'echo "Installing Homebrew..."',
      'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || echo "WARNING: Homebrew installation failed"',
      '',
      '# Add NVM to bashrc if not already there',
      'if ! grep -q \'NVM_DIR\' ~/.bashrc; then',
      '    echo \'export NVM_DIR="$HOME/.nvm"\' >> ~/.bashrc',
      '    echo \'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\' >> ~/.bashrc',
      'fi',
      '',
      '# Add Homebrew to bashrc if it was installed',
      'if [ -d /home/linuxbrew/.linuxbrew ]; then',
      '    if ! grep -q \'linuxbrew\' ~/.bashrc; then',
      '        echo >> ~/.bashrc',
      '        echo \'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"\' >> ~/.bashrc',
      '    fi',
      '    # Load Homebrew for immediate use',
      '    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"',
      '    # Install GCC (recommended by Homebrew)',
      '    brew install gcc || echo "WARNING: GCC installation failed"',
      'fi',
      'UBUNTU_SCRIPT',
      '',
      '# Install build-essential for Homebrew (as root)',
      'apt-get install -y build-essential',
      '',
      // Retrieve API key from Parameter Store
      '# Retrieve API key from Parameter Store',
      `API_KEY=$(aws ssm get-parameter --name "${apiKeyParameter.parameterName}" --with-decryption --query Parameter.Value --output text --region ${Stack.of(this).region})`,
      `echo "export ${apiKeyEnvVar}=\\"$API_KEY\\"" >> /home/ubuntu/.bashrc`,
      '',
      '# Enable systemd linger for ubuntu user (required for user services to run at boot)',
      'loginctl enable-linger ubuntu',
      '',
      '# Wait for user systemd to be ready',
      'sleep 2',
      '',
      '# Ensure XDG_RUNTIME_DIR is set for user services',
      'mkdir -p /run/user/1000',
      'chown ubuntu:ubuntu /run/user/1000',
      'chmod 700 /run/user/1000',
      '',
      '# Start user systemd instance',
      'systemctl start user@1000.service || true',
      '',
      // Run OpenClaw onboarding with appropriate API key
      '# Run OpenClaw onboarding as ubuntu user',
      'echo "Running OpenClaw onboarding..."',
      `sudo -H -u ubuntu bash << 'ONBOARD_SCRIPT'`,
      'export HOME=/home/ubuntu',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      'export XDG_RUNTIME_DIR=/run/user/1000',
      `API_KEY=$(aws ssm get-parameter --name "${apiKeyParameter.parameterName}" --with-decryption --query Parameter.Value --output text --region ${Stack.of(this).region})`,
      `export ${apiKeyEnvVar}="$API_KEY"`,
      '',
      apiProvider === 'openrouter' 
        ? `openclaw onboard --non-interactive --accept-risk \\\n    --mode local \\\n    --auth-choice apiKey \\\n    --token-provider openrouter \\\n    --token "$API_KEY" \\\n    --gateway-port ${gatewayPort} \\\n    --gateway-bind loopback \\\n    --skip-daemon \\\n    --skip-skills || echo "WARNING: OpenClaw onboarding failed. Run openclaw onboard manually."`
        : `openclaw onboard --non-interactive --accept-risk \\\n    --mode local \\\n    --auth-choice apiKey \\\n    --${apiProvider === 'custom' ? 'anthropic' : apiProvider}-api-key "$API_KEY" \\\n    --gateway-port ${gatewayPort} \\\n    --gateway-bind loopback \\\n    --skip-daemon \\\n    --skip-skills || echo "WARNING: OpenClaw onboarding failed. Run openclaw onboard manually."`,
      'ONBOARD_SCRIPT',
      '',
      '# Install daemon service',
      'echo "Installing OpenClaw daemon..."',
      'sudo -H -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 bash << \'DAEMON_SCRIPT\'',
      'export HOME=/home/ubuntu',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      'export XDG_RUNTIME_DIR=/run/user/1000',
      '',
      '# Install but do not start the daemon yet',
      'openclaw daemon install --no-start || echo "WARNING: Daemon install failed. Run openclaw daemon install manually."',
      'DAEMON_SCRIPT',
      '',
      '# Configure gateway with authentication token',
      'echo "Configuring gateway..."',
      `sudo -H -u ubuntu GATEWAY_TOKEN="${gatewayToken}" bash << 'CONFIG_SCRIPT'`,
      'export HOME=/home/ubuntu',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      'export XDG_RUNTIME_DIR=/run/user/1000',
      '',
      'config_path="/home/ubuntu/.openclaw/openclaw.json"',
      'if [ -f "$config_path" ]; then',
      '    # Update the gateway token using sed',
      `    sed -i 's/"token": "[^"]*"/"token": "'"$GATEWAY_TOKEN"'"/' "$config_path"`,
      '    echo "Configured gateway with authentication token: $GATEWAY_TOKEN"',
      '    ',
      '    # Start the daemon with the correct token',
      '    openclaw daemon start || echo "WARNING: Could not start daemon"',
      'else',
      '    echo "WARNING: OpenClaw config not found. Onboarding may have failed."',
      'fi',
      'CONFIG_SCRIPT',
      '',
      '# Ensure proper ownership of .openclaw directory',
      'chown -R ubuntu:ubuntu /home/ubuntu/.openclaw',
      '',
      '# Create completion marker',
      'touch /tmp/openclaw-setup-complete',
      '',
      'echo "OpenClaw setup complete!"',
      `echo "Gateway Token: ${gatewayToken}"`,
      `echo "Access via SSH: ssh -i <key> ubuntu@<public-ip>"`,
      `echo "Or use SSM: aws ssm start-session --target <instance-id>"`,
      `echo "Dashboard: http://localhost:${gatewayPort}/?token=${gatewayToken} (via port forward)`
    );

    // Parse instance type from config
    const instanceClass = InstanceClass[config.instanceType.class as keyof typeof InstanceClass];
    const instanceSize = InstanceSize[config.instanceType.size as keyof typeof InstanceSize];

    // EC2 instance
    const instance = new Instance(this, 'OpenClawEc2', {
      vpc,
      instanceType: InstanceType.of(instanceClass, instanceSize),
      machineImage: ami,
      securityGroup: sg,
      role,
      userData,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      keyName: keyPair.keyName as string,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: {
            ebsDevice: {
              volumeSize: 30,
              volumeType: 'gp3' as any,
              encrypted: true,
              deleteOnTermination: true,
            },
          },
        },
      ],
    });

    // Add tags for easy identification
    instance.instance.addPropertyOverride('Tags', [
      { Key: 'Name', Value: config.instanceName },
      { Key: 'Project', Value: config.projectName },
      { Key: 'ManagedBy', Value: 'openclaw-aws' },
    ]);

    // Store SSH private key in Secrets Manager
    const sshSecret = new Secret(this, 'OpenClawSSHKey', {
      secretName: `${Stack.of(this).stackName}-ssh-key`,
      description: 'SSH private key for OpenClaw EC2 instance',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          keyName: keyPair.keyName,
          publicKey: keyPair.attrKeyFingerprint,
        }),
        generateStringKey: 'privateKey',
        excludePunctuation: true,
      },
    });

    // Outputs
    new CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
      exportName: `${id}-InstanceId`,
    });

    new CfnOutput(this, 'InstanceName', {
      value: config.instanceName,
      description: 'EC2 Instance Name',
    });

    new CfnOutput(this, 'SSHKeyName', {
      value: keyPair.keyName,
      description: 'SSH Key Pair Name',
    });

    new CfnOutput(this, 'GatewayToken', {
      value: gatewayToken,
      description: 'OpenClaw Gateway Authentication Token',
    });

    new CfnOutput(this, 'GatewayPort', {
      value: gatewayPort.toString(),
      description: 'OpenClaw Gateway Port',
    });

    new CfnOutput(this, 'SSHConnectCommand', {
      value: `ssh -i <path-to-key> ubuntu@<instance-public-ip>`,
      description: 'SSH connection command (get IP from EC2 console)',
    });

    new CfnOutput(this, 'SSMConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${Stack.of(this).region}`,
      description: 'SSM connection command',
    });

    new CfnOutput(this, 'SSMPortForwardCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=${gatewayPort},localPortNumber=${gatewayPort}" --region ${Stack.of(this).region}`,
      description: `Port forwarding command for dashboard (access at http://localhost:${gatewayPort})`,
    });

    new CfnOutput(this, 'SetupInstructions', {
      value: [
        'Setup Instructions:',
        '1. Get SSH key from AWS Secrets Manager:',
        `   aws secretsmanager get-secret-value --secret-id ${sshSecret.secretName} --query SecretString --output text | jq -r '.privateKey' > openclaw-key.pem`,
        '   chmod 600 openclaw-key.pem',
        '',
        '2. Connect via SSH (if enabled):',
        `   ssh -i openclaw-key.pem ubuntu@<instance-public-ip>`,
        '',
        '3. Or connect via SSM (recommended):',
        `   aws ssm start-session --target ${instance.instanceId}`,
        '',
        '4. Check OpenClaw status:',
        '   openclaw status',
        '',
        '5. Start gateway manually (if needed):',
        `   openclaw gateway --port ${gatewayPort}`,
        '',
        '6. Access dashboard via SSM port forward:',
        `   aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=${gatewayPort},localPortNumber=${gatewayPort}"`,
        `   Then open: http://localhost:${gatewayPort}/?token=${gatewayToken}`,
      ].join('\n'),
      description: 'Post-deployment instructions',
    });
  }
}

export default OpenClawStack;
