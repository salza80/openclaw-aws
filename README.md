# openclaw-aws

Deploy OpenClaw AI agents on AWS with a simple, interactive CLI.

## Features

- 🚀 **One-command deployment** - Interactive setup wizard
- 🔒 **Secure by default** - SSM-only access, no SSH, no open ports
- 💰 **Cost-effective** - ~$7.50/month (t3.micro free tier eligible)
- 🎯 **Easy management** - Simple commands for all operations
- 📦 **Automated setup** - Node.js and OpenClaw CLI pre-installed

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

**Options:**
- `--region <region>` - AWS region (default: prompts)
- `--instance-type <type>` - EC2 instance type (default: prompts)
- `--yes, -y` - Use defaults, no prompts

**Example:**
```bash
# Interactive mode
openclaw-aws init

# Non-interactive with defaults
openclaw-aws init --yes --region us-east-1
```

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

**Example:**
```bash
openclaw-aws connect
```
#### commands to view logs:
```bash
sudo cat /var/log/cloud-init-output.log
Cloud-init general log:
sudo cat /var/log/cloud-init.log
User data script log (if any errors):
sudo cat /var/log/user-data.log
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
    "name": "openclaw-my-bot",
    "nodeVersion": 22,
    "amiType": "amazon-linux-2"
  },
  "features": {
    "cloudWatchLogs": true
  },
  "stack": {
    "name": "OpenclawStack-my-bot"
  }
}
```

## Architecture

The deployment creates:

- **EC2 Instance** - Amazon Linux 2, t3.micro (or your chosen type)
- **Security Group** - No inbound rules (SSM only)
- **IAM Role** - Least-privilege with SSM access
- **VPC** - Uses default VPC, public subnet (for outbound only)

## Security

- ✅ **No SSH** - All access via AWS Systems Manager (SSM)
- ✅ **No Open Ports** - Security group has zero inbound rules
- ✅ **IAM Least Privilege** - Only SSM permissions
- ✅ **Private Dashboard** - Access via SSM port forwarding only
- ✅ **Audited Access** - All SSM sessions are logged

## Cost Breakdown

**Monthly AWS Costs:**
- EC2 t3.micro: ~$7.50/month (free tier: 750 hours/month for 12 months)
- SSM: No additional cost
- Data Transfer: Minimal (mostly outbound API calls)

**Variable Costs:**
- Anthropic Claude API: Usage-based
- Other LLM APIs: Usage-based

**Total Infrastructure**: ~$7.50/month after free tier

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
