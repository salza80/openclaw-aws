import { Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Instance,
  InstanceType,
  InstanceClass,
  InstanceSize,
  MachineImage,
  BlockDeviceVolume,
  EbsDeviceVolumeType,
  SecurityGroup,
  UserData,
  SubnetType,
  Vpc,
  IVpc,
} from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { StackConfig } from '../cli/types/index.js';
import type { Provider } from '../cli/types/index.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';

export interface OpenClawStackProps extends StackProps {
  config: StackConfig;
  apiProvider: Provider;
  apiKeyParamName: string;
  gatewayTokenParamName: string;
  useDefaultVpc: boolean;
}

export class OpenClawStack extends Stack {
  constructor(scope: Construct, id: string, props: OpenClawStackProps) {
    super(scope, id, props);

    const { config, apiProvider, apiKeyParamName, gatewayTokenParamName } = props;
    const gatewayPort = 18789;
    const gatewayLogPath = '/home/ubuntu/.openclaw/logs/gateway.log';
    const logGroupName = `/openclaw/${this.stackName}`;
    const logGroup = config.enableCloudWatchLogs
      ? new LogGroup(this, 'OpenClawLogs', {
          logGroupName,
          retention: RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        })
      : undefined;

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

    // IAM role for SSM; log permissions are scoped to this deployment's log group.
    const managedPolicies = [
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    ];

    const role = new Role(this, 'OpenClawEc2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies,
    });
    const logGrant = logGroup?.grantWrite(role);

    const apiKeyParamArn = Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: apiKeyParamName.replace(/^\/+/, ''),
    });
    const gatewayTokenParamArn = Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: gatewayTokenParamName.replace(/^\/+/, ''),
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParameterHistory'],
        resources: [apiKeyParamArn, gatewayTokenParamArn],
      }),
    );

    // Determine AMI - Ubuntu 24.04 LTS
    const ami = MachineImage.lookup({
      name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
      owners: ['099720109477'], // Canonical
    });

    // UserData script - simplified without Tailscale
    const userData = UserData.forLinux();

    // Set appropriate environment variable based on API provider
    const apiKeyEnvVar = apiProvider.toUpperCase().replace(/-/g, '_');
    const authChoiceFlag = apiProvider === 'anthropic-api-key' ? 'apiKey' : apiProvider;
    const gatewayConfigFilter =
      'if (.gateway | type) == "object" then .gateway.auth.token = $token else . + {gateway:{auth:{token:$token}}} end' +
      (logGroup ? ` | .logging.file = "${gatewayLogPath}"` : '');

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
      'apt-get install -y curl git python3 python3-pip jq wget snapd unzip',
      '',
      '# Install AWS CLI v2 (apt package is not available on Ubuntu 24.04)',
      'if ! command -v aws >/dev/null 2>&1; then',
      '  ARCH="$(uname -m)"',
      '  if [ "$ARCH" = "aarch64" ]; then',
      '    AWSCLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"',
      '  else',
      '    AWSCLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"',
      '  fi',
      '  curl -fsSL "$AWSCLI_URL" -o /tmp/awscliv2.zip',
      '  unzip -q /tmp/awscliv2.zip -d /tmp',
      '  /tmp/aws/install || /tmp/aws/install --update',
      'fi',
      '',
      ...(logGroup
        ? [
            '# Install and start log collection before onboarding so failures are captured',
            `curl -fsSL --retry 3 https://amazoncloudwatch-agent-${Stack.of(this).region}.s3.${Stack.of(this).region}.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -o /tmp/amazon-cloudwatch-agent.deb`,
            'dpkg -i /tmp/amazon-cloudwatch-agent.deb',
            "cat > /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json << 'CLOUDWATCH_CONFIG'",
            JSON.stringify({
              agent: { region: Stack.of(this).region },
              logs: {
                logs_collected: {
                  files: {
                    collect_list: [
                      { file_path: '/var/log/cloud-init-output.log', stream: 'bootstrap' },
                      { file_path: '/var/log/cloud-init.log', stream: 'cloud-init' },
                      { file_path: gatewayLogPath, stream: 'gateway' },
                    ].map(({ file_path, stream }) => ({
                      file_path,
                      log_group_name: logGroupName,
                      log_stream_name: `{instance_id}/${stream}`,
                    })),
                  },
                },
              },
            }),
            'CLOUDWATCH_CONFIG',
            'systemctl enable amazon-cloudwatch-agent',
            '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json',
            '',
          ]
        : []),
      '# Load API key from SSM Parameter Store',
      `export AWS_REGION="${Stack.of(this).region}"`,
      `export AWS_DEFAULT_REGION="${Stack.of(this).region}"`,
      `API_KEY_PARAM_NAME="${apiKeyParamName}"`,
      'API_KEY="$(aws ssm get-parameter --with-decryption --name "$API_KEY_PARAM_NAME" --query Parameter.Value --output text || true)"',
      'if [ -z "$API_KEY" ]; then',
      '  echo "ERROR: API key not found in SSM Parameter Store"; exit 1',
      'fi',
      '',
      '# Load gateway token from SSM Parameter Store',
      `GATEWAY_TOKEN_PARAM_NAME="${gatewayTokenParamName}"`,
      'GATEWAY_TOKEN="$(aws ssm get-parameter --with-decryption --name "$GATEWAY_TOKEN_PARAM_NAME" --query Parameter.Value --output text || true)"',
      'if [ -z "$GATEWAY_TOKEN" ]; then',
      '  echo "ERROR: Gateway token not found in SSM Parameter Store"; exit 1',
      'fi',
      '',
      '# Install Docker',
      'curl -fsSL https://get.docker.com | sh',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ubuntu',
      '',
      '# Install NVM and Node.js for ubuntu user',
      "sudo -u ubuntu bash << 'UBUNTU_SCRIPT'",
      'set -e',
      'cd ~',
      '',
      '# Install NVM',
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash',
      '',
      '# Load NVM',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      '',
      `# Install Node.js ${OPENCLAW_NODE_VERSION}`,
      `nvm install ${OPENCLAW_NODE_VERSION}`,
      `nvm use ${OPENCLAW_NODE_VERSION}`,
      `nvm alias default ${OPENCLAW_NODE_VERSION}`,
      '',
      '# Install OpenClaw',
      `npm install -g openclaw@${OPENCLAW_VERSION} --allow-scripts=openclaw`,
      '',
      '# Install Homebrew (non-interactive, no sudo required)',
      'echo "Installing Homebrew..."',
      'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || echo "WARNING: Homebrew installation failed"',
      '',
      '# Add NVM to bashrc if not already there',
      "if ! grep -q 'NVM_DIR' ~/.bashrc; then",
      '    echo \'export NVM_DIR="$HOME/.nvm"\' >> ~/.bashrc',
      '    echo \'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\' >> ~/.bashrc',
      'fi',
      '',
      '# Add Homebrew to bashrc if it was installed',
      'if [ -d /home/linuxbrew/.linuxbrew ]; then',
      "    if ! grep -q 'linuxbrew' ~/.bashrc; then",
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
      'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      '',
      '# Start user systemd instance',
      'systemctl start user@1000.service || true',
      '',
      // Run OpenClaw onboarding with appropriate API key
      '# Run OpenClaw onboarding as ubuntu user',
      'echo "Running OpenClaw onboarding..."',
      `sudo -H -u ubuntu API_KEY="$API_KEY" bash << 'ONBOARD_SCRIPT'`,
      'set -e',
      'export HOME=/home/ubuntu',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      'export XDG_RUNTIME_DIR=/run/user/1000',
      'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      `export ${apiKeyEnvVar}="$API_KEY"`,
      '',
      `openclaw onboard --non-interactive --accept-risk \\\n    --mode local \\\n    --auth-choice ${authChoiceFlag} \\\n    --${apiProvider} "$${apiKeyEnvVar}" \\\n    --gateway-port ${gatewayPort} \\\n    --gateway-bind loopback \\\n    --skip-daemon \\\n    --skip-skills`,
      'ONBOARD_SCRIPT',
      '',
      '# Configure gateway with authentication token',
      'echo "Configuring gateway..."',
      `sudo -H -u ubuntu GATEWAY_TOKEN="$GATEWAY_TOKEN" bash << 'CONFIG_SCRIPT'`,
      'set -e',
      'export HOME=/home/ubuntu',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      'export XDG_RUNTIME_DIR=/run/user/1000',
      'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      '',
      ...(logGroup ? ['mkdir -p /home/ubuntu/.openclaw/logs'] : []),
      'config_path="/home/ubuntu/.openclaw/openclaw.json"',
      'if [ -f "$config_path" ]; then',
      '    # Update gateway token safely via jq',
      '    tmp_config="$(mktemp)"',
      `    if jq --arg token "$GATEWAY_TOKEN" '${gatewayConfigFilter}' "$config_path" > "$tmp_config"; then`,
      '        mv "$tmp_config" "$config_path"',
      '        echo "Configured gateway with authentication token"',
      '    else',
      '        rm -f "$tmp_config"',
      '        echo "ERROR: Failed to update gateway token in config"; exit 1',
      '    fi',
      '    ',
      '    # Install and start only after the final token is configured',
      '    openclaw gateway install',
      'else',
      '    echo "ERROR: OpenClaw config not found. Onboarding may have failed."; exit 1',
      'fi',
      'CONFIG_SCRIPT',
      '',
      '# Ensure proper ownership of .openclaw directory',
      'chown -R ubuntu:ubuntu /home/ubuntu/.openclaw',
      '',
      '# Restart daemon as ubuntu user to ensure it picks up all changes',
      "sudo -H -u ubuntu bash << 'RESTART_SCRIPT'",
      'set -e',
      'export HOME=/home/ubuntu',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      'export XDG_RUNTIME_DIR=/run/user/1000',
      'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      'openclaw gateway restart',
      'RESTART_SCRIPT',
      '',
      '# Create completion marker',
      'touch /tmp/openclaw-setup-complete',
      '',
      'echo "OpenClaw setup complete!"',
      `echo "Gateway Token stored in SSM Parameter Store"`,
      `echo "Or use SSM: aws ssm start-session --target <instance-id>"`,
      `echo "Dashboard: http://localhost:${gatewayPort} (via port forward)"`,
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
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: BlockDeviceVolume.ebs(30, {
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    logGrant?.applyBefore(instance);

    // Add tags for easy identification
    instance.instance.addPropertyOverride('Tags', [
      { Key: 'Name', Value: config.instanceName },
      { Key: 'Project', Value: config.projectName },
      { Key: 'ManagedBy', Value: 'openclaw-aws' },
    ]);

    // Outputs
    if (logGroup) {
      new CfnOutput(this, 'LogGroupName', {
        value: logGroup.logGroupName,
        description: 'CloudWatch log group for bootstrap and OpenClaw logs (30-day retention)',
      });
    }

    new CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
      exportName: `${id}-InstanceId`,
    });

    new CfnOutput(this, 'InstanceName', {
      value: config.instanceName,
      description: 'EC2 Instance Name',
    });

    new CfnOutput(this, 'GatewayPort', {
      value: gatewayPort.toString(),
      description: 'OpenClaw Gateway Port',
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
        '1. Connect via SSM (recommended):',
        `   aws ssm start-session --target ${instance.instanceId}`,
        '',
        '2. Check OpenClaw status:',
        '   openclaw status',
        '',
        '3. Start gateway manually (if needed):',
        `   openclaw gateway --port ${gatewayPort}`,
        '',
        '4. Access dashboard via SSM port forward:',
        `   aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=${gatewayPort},localPortNumber=${gatewayPort}"`,
        `   Then open: http://localhost:${gatewayPort}`,
        '   Tip: Use openclaw-aws dashboard to include the token automatically.',
      ].join('\n'),
      description: 'Post-deployment instructions',
    });
  }
}

export default OpenClawStack;
