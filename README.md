# openclaw-aws

OpenClaw AWS is a CLI that makes it simple provisions and manage OpenClaw bots on AWS. It creates a minimal Ubuntu EC2 setup with secure SSM-only access.

## Quick Start

```bash
# Create a dedicated folder (recommended)
mkdir my-openclaw-bot
cd my-openclaw-bot
npm install @salza80/openclaw-aws

# Initialize your bot with interactive prompts
# This will generate a config file
openclaw-aws init

# Deploy. -- Thats it!
openclaw-aws deploy

# Wait for deploy to finished. View the status of your bot

openclaw-aws status
```

To access your bot:
```bash
# Open the dashboard to view in your browser (port forwarded via secure SSM - not public access)
openclaw-aws dashboard

# Or connect to the intance via SSM - for full terminal access
openclaw-aws connect
# Opens http://localhost:18789 in your browser - short delay before it works - refresh browser after 5 seconds
```

Managing multiple bots / instances:

```bash
# This will generate another config file
openclaw-aws init
# deploy it
openclaw-aws deploy

# List all bot configs
openclaw-aws list

# View status of current selected config
openclaw-aws status --all
# View status of all configs
openclaw-aws status --all

# See current selected config.
# This is the config commands with be defaulted to.
openclaw-aws current

# Select another config
openclase-aws use <name>

# run any command against a specific config or all configs with --name <name> or --all

# get help with commands
openclaw-aws help
```

## Prerequisites

- **Node.js 20+**
- **AWS CLI v2 installed and authenticated** (SSO recommended)
  - Install AWS CLI v2: [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html)
  - Configure SSO: [AWS CLI SSO setup guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

Check deployment and instance status.

### `Commands`
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
- `--name <name>` - Config name
- `--all` - Destroy all configs
- `--force` - Skip confirmation
- `--delete-config` - Delete configuration file

**Example:**
```bash
openclaw-aws destroy --name my-bot
openclaw-aws destroy --all

# Force delete without confirmation
openclaw-aws destroy --name my-bot --force
```

### `openclaw-aws list`

List configs.

**Example:**
```bash
openclaw-aws list
```

### `openclaw-aws current`

Show the current config.

**Example:**
```bash
openclaw-aws current
```

### `openclaw-aws use`

Select a config.

**Example:**
```bash
openclaw-aws use my-bot
```

## Configuration

Configuration is created with init command, and stored per config in `.openclaw-aws/configs/<name>.json`.
The current selection is stored in `.openclaw-aws/current.json`.

**Example configuration:**
```json
{
  "version": "1.0",
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

## Multiple Bots (Configs)

To manage multiple bots, create one config per bot and switch between them:

```bash
openclaw-aws init --name bot-a
openclaw-aws init --name bot-b
openclaw-aws list
openclaw-aws use bot-b
openclaw-aws current
```

## Start/Stop (Cost Control)

Use `stop` to save costs when you don’t need the bot running, and `start` to resume.

```bash
openclaw-aws stop --name my-bot
openclaw-aws start --name my-bot
```

## Benefits & Setup

- **Ubuntu 24.04 LTS** on EC2
- **SSM-only access** (no SSH, no inbound ports)
- **Encrypted EBS** by default
- **IMDSv2 enforced** for metadata security

## Architecture

The deployment creates:

- **EC2 Instance** - Ubuntu 24.04 LTS, t3.micro (or your chosen type)
  - IMDSv2 enforced (SSRF protection)
  - Encrypted EBS volume (data at rest encryption)
  - Public IP assigned (required for outbound connectivity)
- **Security Group** - Zero inbound rules (SSM access only, no SSH)
- **IAM Role** - Least-privilege with SSM access
- **VPC** - Uses default VPC by default (option to create new VPC)

## Security

- **No inbound ports** (SSM access only)
- **No SSH** (disabled by design)
- **Encrypted storage** with EBS
- **SSM sessions** are auditable in CloudTrail

### Troubleshooting - Instance not appearing in SSM

Wait 2-3 minutes after deployment. Check status:
```bash
openclaw-aws status
```

### "Config file not found"

Run the init command first:
```bash
openclaw-aws init
openclaw-aws list
openclaw-aws use my-bot
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

Restart instance - if gateway or SSM has crashed
```bash
openclaw-aws restart
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
