# openclaw-aws

Deploy OpenClaw AI agents on AWS with a simple, interactive CLI.

## Features

- 🚀 **One-command deployment** - Interactive setup wizard
- 🔒 **Secure by default** - SSM-only access, SSH disabled, no open ports, encrypted secrets
- 💰 **Cost-effective** - ~$7.55/month (t3.micro free tier eligible)
- 🎯 **Easy management** - Simple commands for all operations
- 📦 **Automated setup** - Node.js and OpenClaw CLI pre-installed
- 🔐 **Enterprise security** - IMDSv2, encrypted EBS, Parameter Store for secrets

## Quick Start

```bash
# Initialize configuration (interactive wizard)
openclaw-aws init

# Deploy to AWS
openclaw-aws deploy

# Connect and run onboarding
openclaw-aws onboard

# Access dashboard
openclaw-aws dashboard
```

## Prerequisites

Before using openclaw-aws, ensure you have:

1. **Node.js 18+** installed
2. **AWS CLI** configured with credentials (`aws configure`)
3. **AWS SSM Plugin** installed:
   ```bash
   # macOS
   brew install --cask session-manager-plugin
   
   # Ubuntu/Debian
   curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
   sudo dpkg -i session-manager-plugin.deb
   ```

4. **Anthropic API Key** (for Claude) from https://console.anthropic.com/
5. **(Optional) Brave Search API Key** for web search capabilities

## Installation

### From GitHub Packages (Private)

```bash
# First, authenticate with GitHub Packages
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc

# Install globally
npm install -g @YOUR_GITHUB_USERNAME/openclaw-aws
```

### From Git Repository

```bash
npm install -g git+ssh://git@github.com/YOUR_GITHUB_USERNAME/openclaw-aws.git
```

### Local Development

```bash
# Clone the repo
git clone https://github.com/YOUR_GITHUB_USERNAME/openclaw-aws.git
cd openclaw-aws

# Install dependencies
pnpm install

# Build
pnpm run build

# Link for local testing
export PATH="/Users/smclean/.nvm/versions/node/v22.20.0/bin:$PATH"
cd /Users/smclean/openclaw-aws
npm link

npm link
```

## Commands

### `openclaw-aws init`

Interactive setup wizard to create your deployment configuration.

During initialization, you'll be prompted for:
- AWS region
- EC2 instance type
- VPC selection (default VPC recommended vs create new VPC)
- SSH access (disabled by default, recommended to keep disabled)
- SSH source IP/CIDR (only if SSH enabled)

**Options:**
- `--region <region>` - AWS region (default: prompts)
- `--instance-type <type>` - EC2 instance type (default: prompts)
- `--yes, -y` - Use secure defaults, no prompts (SSH disabled, default VPC)

**Example:**
```bash
# Interactive mode (recommended for first time)
openclaw-aws init

# Non-interactive with secure defaults
openclaw-aws init --yes --region us-east-1
```

**Security Defaults (--yes mode):**
- Uses default VPC (simpler, no extra VPC costs)
- SSH disabled (SSM-only access)
- IMDSv2 enforced
- EBS encryption enabled
- API keys stored in Parameter Store

### `openclaw-aws deploy`

Deploy infrastructure to AWS.

**Options:**
- `--auto-approve` - Skip confirmation prompt
- `--config <path>` - Use specific config file

**Example:**
```bash
openclaw-aws deploy
openclaw-aws deploy --auto-approve
```

### `openclaw-aws connect`

Connect to your EC2 instance via SSM.

**Note:** This is the primary method for accessing your instance. SSH is disabled by default for security.

**Example:**
```bash
openclaw-aws connect
```

#### Commands to view logs:
```bash
# User data execution log
sudo cat /var/log/cloud-init-output.log

# Cloud-init general log
sudo cat /var/log/cloud-init.log

# User data script log (if any errors)
sudo cat /var/log/user-data.log
```

#### Verify API key retrieval from Parameter Store:
```bash
# Check if API key was successfully retrieved
echo $ANTHROPIC_API_KEY

# View Parameter Store parameter (will show encrypted value)
aws ssm get-parameter --name /openclaw/my-bot/api-key --region us-east-1
```


### `openclaw-aws onboard`

Connect to instance with onboarding instructions and guidance.

**Example:**
```bash
openclaw-aws onboard

# Once connected, run:
openclaw onboard --install-daemon
```

### `openclaw-aws dashboard`

Forward port 18789 to access the OpenClaw dashboard locally.

**Options:**
- `--no-open` - Don't open browser automatically

**Example:**
```bash
openclaw-aws dashboard
# Opens http://localhost:18789 in your browser
```

### `openclaw-aws status`

Check deployment and instance status.

**Example:**
```bash
openclaw-aws status
```

### `openclaw-aws outputs`

Show CloudFormation stack outputs.

**Example:**
```bash
openclaw-aws outputs
```

### `openclaw-aws destroy`

Delete all AWS resources.

**Options:**
- `--force` - Skip confirmation
- `--keep-config` - Keep configuration file

**Example:**
```bash
openclaw-aws destroy

# Force delete without confirmation
openclaw-aws destroy --force
```

## Configuration

Configuration is stored in `.openclaw-aws/config.json` in your project directory.

**Example configuration:**
```json
{
  "version": "1.0",
  "projectName": "my-openclaw-bot",
  "aws": {
    "region": "us-east-1",
    "profile": "default"
  },
  "instance": {
    "type": "t3.micro",
    "name": "openclaw-my-bot"
  },
  "network": {
    "useDefaultVpc": true
  },
  "security": {
    "enableSsh": false,
    "sshSourceIp": "0.0.0.0/0"
  },
  "features": {
    "cloudWatchLogs": true
  },
  "openclaw": {
    "apiProvider": "anthropic"
  },
  "stack": {
    "name": "OpenclawStack-my-bot"
  }
}
```

### Configuration Fields

**instance:**
- `type` (string) - EC2 instance type (e.g., "t3.micro", "t3.small")
- `name` (string) - Name tag for the EC2 instance

**network:**
- `useDefaultVpc` (boolean) - Use your AWS default VPC (recommended) vs creating a new VPC

**security:**
- `enableSsh` (boolean) - Enable SSH access to instance (default: false, recommended: keep disabled)
- `sshSourceIp` (string) - CIDR block for SSH access (only used if SSH enabled, e.g., "1.2.3.4/32")

**features:**
- `cloudWatchLogs` (boolean) - Enable CloudWatch Logs integration (adds CloudWatchAgentServerPolicy to IAM role)

**openclaw:**
- `apiProvider` (string) - LLM API provider: "anthropic", "openrouter", "openai", or "custom"

**Note:** 
- SSH is disabled by default. SSM Session Manager is the recommended access method.
- Node.js 22 is hardcoded in the instance setup (not configurable)
- Ubuntu 24.04 LTS is the AMI used (not configurable)

## Architecture

The deployment creates:

- **EC2 Instance** - Ubuntu 24.04 LTS, t3.micro (or your chosen type)
  - IMDSv2 enforced (SSRF protection)
  - Encrypted EBS volume (data at rest encryption)
  - Public IP assigned (required for outbound connectivity)
- **Security Group** - No inbound rules by default (SSH optional, disabled by default)
- **IAM Role** - Least-privilege with SSM and Parameter Store access
- **VPC** - Uses default VPC by default (option to create new VPC)
- **Parameter Store** - SecureString parameter for encrypted API key storage

## Security

OpenClaw-AWS implements multiple layers of security following AWS best practices:

### Access Control
- ✅ **SSH Disabled by Default** - All access via AWS Systems Manager (SSM)
- ✅ **No Open Ports** - Security group has zero inbound rules by default
- ✅ **Optional SSH** - Can be enabled with IP restrictions during `init` if needed
- ✅ **Private Dashboard** - Access via SSM port forwarding only
- ✅ **Audited Access** - All SSM sessions are logged in CloudTrail

### Secrets Management
- ✅ **Encrypted API Keys** - Stored as SecureString in AWS Parameter Store (not in UserData)
- ✅ **At-Rest Encryption** - API keys encrypted using AWS-managed KMS keys
- ✅ **Runtime Retrieval** - Instance fetches API keys from Parameter Store at boot

### Instance Hardening
- ✅ **IMDSv2 Required** - Protection against SSRF attacks (Instance Metadata Service v2)
- ✅ **Encrypted EBS** - All disk volumes encrypted at rest
- ✅ **IAM Least Privilege** - Only SSM and Parameter Store permissions granted
- ✅ **Public Subnet with No Inbound** - Instance can reach internet but nothing can reach it

### Network Security
- ✅ **VPC Isolation** - Uses default VPC or creates dedicated VPC
- ✅ **No Elastic IP** - Uses standard public IP (changes on stop/start)
- ✅ **Outbound Only** - Instance needs internet for package updates and API calls
- ✅ **No Direct SSH** - Even if enabled, SSH is restricted to specific IP/CIDR

### Why Public IP with No Open Ports is Safe
The instance is placed in a public subnet with a public IP to enable:
- Outbound API calls to LLM providers (Anthropic, OpenAI, etc.)
- Outbound package updates (npm, system updates)
- SSM connectivity to AWS services

However, with **zero inbound security group rules**, the public IP cannot receive any incoming connections. This is more secure than traditional setups with SSH on port 22 open to the world.

### Cost Impact
Security features add minimal cost:
- **Parameter Store**: ~$0.05/month for SecureString storage
- **IMDSv2**: No additional cost
- **EBS Encryption**: No additional cost
- **SSM**: No additional cost

**Total security overhead**: ~$0.05/month

## Cost Breakdown

**Monthly AWS Costs:**
- EC2 t3.micro: ~$7.50/month (free tier: 750 hours/month for 12 months)
- Parameter Store (SecureString): ~$0.05/month
- SSM: No additional cost
- IMDSv2: No additional cost
- EBS Encryption: No additional cost
- Data Transfer: Minimal (mostly outbound API calls)

**Variable Costs:**
- Anthropic Claude API: Usage-based
- Other LLM APIs: Usage-based

**Total Infrastructure**: ~$7.55/month after free tier

## Migration Guide

If you have an existing openclaw-aws deployment from before the security improvements:

### What Changed
1. **API Keys** - Now stored in Parameter Store (encrypted) instead of plaintext in UserData
2. **SSH** - Now disabled by default (was open to 0.0.0.0/0 before)
3. **VPC** - Can now use default VPC (simpler) or create new VPC
4. **IMDSv2** - Now enforced on all instances (SSRF protection)
5. **EBS** - Now encrypted at rest
6. **Elastic IP** - Removed (instance gets standard public IP)
7. **Config cleanup** - Removed unused fields: `nodeVersion` (hardcoded to 22), `model`, `enableSandbox` (OpenClaw handles these)

### How to Migrate
1. **Backup your data** (if any) from the existing instance
2. **Run `openclaw-aws destroy`** to remove old infrastructure
3. **Run `openclaw-aws init`** to create new configuration with security improvements
4. **Run `openclaw-aws deploy`** to deploy with new security features
5. **Run `openclaw-aws onboard`** to set up OpenClaw again

### Configuration Updates
Your old config needs these new fields:
```json
{
  "network": {
    "useDefaultVpc": true
  },
  "security": {
    "enableSsh": false,
    "sshSourceIp": "0.0.0.0/0"
  },
  "openclaw": {
    "apiProvider": "anthropic"
  }
}
```

**Note:** The `init` command will create a properly formatted config automatically.

## Troubleshooting

### Instance not appearing in SSM

Wait 2-3 minutes after deployment. Check status:
```bash
openclaw-aws status
```

### "Config file not found"

Run the init command first:
```bash
openclaw-aws init
```

### Deployment fails

Check AWS credentials:
```bash
aws sts get-caller-identity
```

Ensure CDK is bootstrapped:
```bash
cdk bootstrap aws://ACCOUNT-ID/REGION
```

### Port forwarding fails

Ensure SSM plugin is installed and instance is ready:
```bash
openclaw-aws status
```

## Publishing to GitHub Packages

1. **Update package.json** with your GitHub username
2. **Create GitHub repo** and push code
3. **Generate GitHub token** with `write:packages` permission
4. **Authenticate:**
   ```bash
   npm login --registry=https://npm.pkg.github.com
   ```
5. **Publish:**
   ```bash
   npm publish
   ```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Watch mode
pnpm run watch

# Link for local testing
npm link

# Test commands
openclaw-aws --help
openclaw-aws init
```

## Learn More

- **OpenClaw Documentation**: https://docs.openclaw.ai/
- **OpenClaw GitHub**: https://github.com/openclaw/openclaw
- **AWS CDK**: https://docs.aws.amazon.com/cdk/
- **AWS Systems Manager**: https://docs.aws.amazon.com/systems-manager/

## License

MIT

## Author

Sally Mclean <smclean17@gmail.com>
