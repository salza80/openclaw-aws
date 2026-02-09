# openclaw-aws

Deploy OpenClaw AI agents on AWS with a simple, interactive CLI.

## Features

- 🚀 **One-command deployment** - Interactive setup wizard
- 🔒 **Secure by default** - SSM-only access, zero open ports, encrypted secrets
- 💰 **Cost-effective** - ~$7.55/month (t3.micro free tier eligible)
- 🎯 **Easy management** - Simple commands for all operations
- 📦 **Automated setup** - Node.js and OpenClaw CLI pre-installed
- 🔐 **Enterprise security** - IMDSv2, encrypted EBS, Parameter Store for secrets

## Quick Start

```bash
# Initialize configuration (interactive wizard)
openclaw-aws init

# Deploy to AWS
openclaw-aws deploy --name my-bot

# Connect to vps via SSM for terminal access
openclaw-aws connect --name my-bot

# Access dashboard via SSM port forwarding
openclaw-aws dashboard --name my-bot

```

## Prerequisites

Before using openclaw-aws, ensure you have:

1. **Node.js 20+** installed (Node 18 support ends January 2026)
   ```bash
   # Check your version
   node --version
   
   # Using NVM to install (recommended)
   nvm install 22
   nvm use 22
   ```

2. **AWS CLI** configured with credentials
   ```bash
   # Option A: AWS SSO (recommended for organizations)
   aws configure sso
   aws sso login --profile your-profile-name
   
   # Option B: IAM credentials
   aws configure
   
   # Verify credentials
   aws sts get-caller-identity
   ```

### Local Development

```bash
# 1. Clone the repository
git clone https://github.com/salza80/openclaw-aws.git
cd openclaw-aws

# 2. Make sure you're using Node 20+
nvm use 22  # or nvm use 20

# 3. Install dependencies
npm install

# 4. Build the project
npm run build

# 5. Link for local testing
npm link

# 6. Test the CLI
openclaw-aws --help

# 7. Watch mode for development (auto-rebuild on changes)
npm run watch
```

### First Time AWS Setup

If this is your first time deploying with CDK in your AWS account/region:

```bash
# 1. Login with AWS SSO (if applicable)
aws sso login --profile your-profile-name

# 2. Get your AWS account ID
aws sts get-caller-identity

# 3. Bootstrap CDK (one-time per account/region)
cdk bootstrap aws://YOUR-ACCOUNT-ID/YOUR-REGION

# Example:
cdk bootstrap aws://360298971790/eu-central-1
```

**Note:** Bootstrap creates a CloudFormation stack (`CDKToolkit`) that contains:
- S3 bucket for CDK assets
- IAM roles for deployment
- ECR repository for Docker images (if needed)

This is a **one-time operation** per AWS account and region.

## Commands

### `openclaw-aws init`

Interactive setup wizard to create your deployment configuration.

During initialization, you'll be prompted for:
- AWS region
- EC2 instance type
- VPC selection (default VPC recommended vs create new VPC)
- CloudWatch Logs (enable/disable)
- API provider selection

**Options:**
- `--name <name>` - Deployment name (recommended for non-interactive mode)
- `--region <region>` - AWS region (default: prompts)
- `--instance-type <type>` - EC2 instance type (default: prompts)
- `--yes, -y` - Use secure defaults, no prompts

**Example:**
```bash
# Interactive mode (recommended for first time)
openclaw-aws init

# Non-interactive with secure defaults
openclaw-aws init --name my-bot --yes --region us-east-1
```
**Security Defaults:**
- Uses default VPC (simpler, no extra VPC costs)
- Zero open ports (SSM-only access, SSH permanently disabled)
- IMDSv2 enforced
- EBS encryption enabled

### `openclaw-aws deploy`

Deploy infrastructure to AWS.

**Options:**
- `--name <name>` - Deployment name
- `--auto-approve` - Skip confirmation prompt

**Example:**
```bash
openclaw-aws deploy --name my-bot
openclaw-aws deploy --name my-bot --auto-approve
```

### `openclaw-aws connect`

Connect to your EC2 instance via SSM.

**Note:** This is the primary method for accessing your instance. SSH is disabled by default for security.

**Example:**
```bash
openclaw-aws connect --name my-bot
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

### `openclaw-aws dashboard`

Forward port 18789 to access the OpenClaw dashboard locally.

**Options:**
- `--name <name>` - Deployment name
- `--no-open` - Don't open browser automatically

**Example:**
```bash
openclaw-aws dashboard --name my-bot
# Opens http://localhost:18789 in your browser - short delay before it works - refresh browser after 5 seconds
```

### `openclaw-aws status`

Check deployment and instance status.

**Example:**
```bash
openclaw-aws status --name my-bot
openclaw-aws status --all
```

### `openclaw-aws outputs`

Show CloudFormation stack outputs.

**Example:**
```bash
openclaw-aws outputs --name my-bot
```

### `openclaw-aws destroy`

Delete all AWS resources.

**Options:**
- `--name <name>` - Deployment name
- `--force` - Skip confirmation
- `--keep-config` - Keep configuration file

**Example:**
```bash
openclaw-aws destroy --name my-bot

# Force delete without confirmation
openclaw-aws destroy --name my-bot --force
```

### `openclaw-aws config`

Manage deployments (list/select current).

**Examples:**
```bash
openclaw-aws config list
openclaw-aws config current
openclaw-aws config use my-bot
```

## Configuration

Configuration is stored per deployment in `.openclaw-aws/configs/<name>.json`.
The current selection is stored in `.openclaw-aws/current.json`.

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

**features:**
- `cloudWatchLogs` (boolean) - Enable CloudWatch Logs integration (adds CloudWatchAgentServerPolicy to IAM role)

**openclaw:**
- `apiProvider` (string) - LLM API provider: "anthropic", "openrouter", "openai", or "custom"

**Note:** 
- Access is via SSM Session Manager only (no SSH, no open ports)
- Node.js 22 is hardcoded in the instance setup (not configurable)
- Ubuntu 24.04 LTS is the AMI used (not configurable)

## Architecture

The deployment creates:

- **EC2 Instance** - Ubuntu 24.04 LTS, t3.micro (or your chosen type)
  - IMDSv2 enforced (SSRF protection)
  - Encrypted EBS volume (data at rest encryption)
  - Public IP assigned (required for outbound connectivity)
- **Security Group** - Zero inbound rules (SSM access only, no SSH)
- **IAM Role** - Least-privilege with SSM and Parameter Store access
- **VPC** - Uses default VPC by default (option to create new VPC)

## Security

OpenClaw-AWS implements multiple layers of security following AWS best practices:

### Access Control - SSM Only (No SSH)

**SSM (Systems Manager Session Manager) - The Only Access Method ✅**
- **Zero open inbound ports** - All traffic is outbound from the instance
- Connect with: `openclaw-aws connect`
- No SSH keys to manage
- All sessions logged in CloudTrail
- Works even behind corporate firewalls
- **SSH is completely disabled and not configurable**

### Security Features
- ✅ **No Open Ports** - Security group has zero inbound rules (SSH permanently disabled)
- ✅ **SSM Access Only** - All instance access via AWS Systems Manager
- ✅ **Private Dashboard** - Access via SSM port forwarding only
- ✅ **Audited Access** - All SSM sessions are logged in CloudTrail

### Instance Hardening
- ✅ **IMDSv2 Required** - Protection against SSRF attacks (Instance Metadata Service v2)
- ✅ **Encrypted EBS** - All disk volumes encrypted at rest
- ✅ **Public Subnet with No Inbound** - Instance can reach internet but nothing can reach it

### Network Security
- ✅ **VPC Isolation** - Uses default VPC or creates dedicated VPC
- ✅ **Outbound Only** - Instance needs internet for package updates and API calls
- ✅ **No Direct SSH** - Even if enabled, SSH is restricted to specific IP/CIDR

The instance is placed in a public subnet with a public IP to enable:
- Outbound API calls to LLM providers (Anthropic, OpenAI, etc.)
- Outbound package updates (npm, system updates)
- SSM connectivity to AWS services

However, with **zero inbound security group rules**, the public IP cannot receive any incoming connections. This is more secure than traditional setups with SSH on port 22 open to the world.

### Cost Impact
Security features add no extra aws cost:
- **IMDSv2**: No additional cost
- **EBS Encryption**: No additional cost
- **SSM**: No additional cost

### AWS SSO Session Expired

**Error:** `The SSO session associated with this profile has expired`

**Solution:**
```bash
# Re-login with SSO
aws sso login --profile your-profile-name

# Then try deployment again
openclaw-aws deploy
```

### Instance not appearing in SSM

Wait 2-3 minutes after deployment. Check status:
```bash
openclaw-aws status
```

### "Config file not found"

Run the init command first:
```bash
openclaw-aws init --name my-bot
openclaw-aws config list
openclaw-aws config use my-bot
```

### Deployment fails

Check AWS credentials:
```bash
aws sts get-caller-identity
```
### Port forwarding fails

Ensure SSM plugin is installed and instance is ready:
```bash
openclaw-aws status
```

## Development

For developers contributing to openclaw-aws:

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/salza80/openclaw-aws.git
cd openclaw-aws

# 2. Use Node 20+
nvm use

# 3. Install dependencies
npm install

# 4. Build the project
npm run build

# 5. Link for local testing
npm link

# 6. Test the CLI
openclaw-aws --help
openclaw-aws init

# 7. Watch mode for development (auto-rebuild on changes)
npm run watch
```

### Requirements for Development

- **Node.js 20+** (required by AWS SDK v3)
- **AWS CLI** with configured credentials
- **AWS account** with CDK bootstrapped
- All dependencies install automatically via `npm install`

### Testing Changes

```bash
# After making changes, rebuild
npm run build

# Test locally in another folder (ie openclaw-aws-test)
openclaw-aws init
openclaw-aws deploy

# Or use watch mode for auto-rebuild
npm run watch
```

## License

MIT

## Author

Sally Mclean <smclean17@gmail.com>
