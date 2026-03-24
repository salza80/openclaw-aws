# openclaw-aws

[![CI](https://github.com/salza80/openclaw-aws/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/salza80/openclaw-aws/actions/workflows/ci.yml) [![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/salza80/openclaw-aws/badges/coverage-badge.json)](https://github.com/salza80/openclaw-aws/actions/workflows/ci.yml)

OpenClaw AWS is a CLI that makes it simple to provision and manage OpenClaw bots on AWS. It creates a minimal Ubuntu EC2 setup with secure SSM-only access.

## Install

```bash
# Recommended: install in your bot folder
mkdir my-openclaw-bot
cd my-openclaw-bot
npm init -y
npm install @salza80/openclaw-aws

# Run the CLI with npx
npx openclaw-aws --help

# Optional: install globally if you prefer not to use npx
npm install -g @salza80/openclaw-aws
openclaw-aws --help
```

## Prerequisites

- **Node.js 22+**
- **AWS CLI v2 installed and authenticated** (SSO recommended)
  - Install AWS CLI v2: [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html)
  - Configure SSO: [AWS CLI SSO setup guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

## Quick Start

```bash
# Initialize your bot with interactive prompts
# This will generate a config file
npx openclaw-aws init

# Set the API key required by your selected provider
# Default provider from init is Anthropic unless you choose another one
export ANTHROPIC_API_KEY=your-api-key

# Deploy
npx openclaw-aws deploy

# Wait for deploy to finish. View the status of your bot
npx openclaw-aws status
```

The examples below use the recommended local-install workflow with `npx openclaw-aws`.

To access your bot:

```bash
# Open the dashboard to view in your browser (port forwarded via secure SSM - not public access)
npx openclaw-aws dashboard
# Opens http://localhost:18789 in your browser - short delay before it works - refresh browser after 5 seconds

# Or connect to the instance via SSM - for full terminal access
npx openclaw-aws connect
```

See the OpenClaw docs for ongoing configuration and usage guidance for your bot: [OpenClaw Documentation](https://docs.openclaw.ai/)

Managing multiple bots / instances:

```bash
# This will generate another config file
npx openclaw-aws init
# deploy it
npx openclaw-aws deploy

# List all bot configs
npx openclaw-aws list

# View status of the currently selected config
npx openclaw-aws status
# View status of all configs
npx openclaw-aws status --all

# See the currently selected config.
# Commands default to this config.
npx openclaw-aws current

# Select another config
npx openclaw-aws use <name>

# Run any command against a specific config or all configs with --name <name> or --all

# get help with commands
npx openclaw-aws --help
```

## Commands

### `openclaw-aws init`

Interactive setup wizard to create a config.

**Example:**

```bash
npx openclaw-aws init
```

### `openclaw-aws deploy`

Deploy infrastructure to AWS.

**Example:**

```bash
npx openclaw-aws deploy
npx openclaw-aws deploy --name my-bot
npx openclaw-aws deploy --all
```

### `openclaw-aws status`

Check deployment and instance status.

**Example:**

```bash
npx openclaw-aws status
npx openclaw-aws status --all
```

### `openclaw-aws dashboard`

Forward port 18789 to access the OpenClaw dashboard locally.

**Example:**

```bash
npx openclaw-aws dashboard
```

### `openclaw-aws connect`

Connect to your EC2 instance via SSM.

**Example:**

```bash
npx openclaw-aws connect
```

### `openclaw-aws start`

Start a stopped instance.

**Example:**

```bash
npx openclaw-aws start
```

### `openclaw-aws stop`

Stop a running instance to save costs.

**Example:**

```bash
npx openclaw-aws stop
```

### `openclaw-aws restart`

Reboot the instance.

**Example:**

```bash
npx openclaw-aws restart
```

### `openclaw-aws outputs`

Show CloudFormation stack outputs.

**Example:**

```bash
npx openclaw-aws outputs --name my-bot
```

### `openclaw-aws logs`

Fetch instance logs (cloud-init and OpenClaw services).

**Example:**

```bash
npx openclaw-aws logs
npx openclaw-aws logs --init
npx openclaw-aws logs --service --tail 100
npx openclaw-aws logs --service --follow
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
npx openclaw-aws destroy --name my-bot
npx openclaw-aws destroy --all

# Force delete without confirmation
npx openclaw-aws destroy --name my-bot --force
```

### `openclaw-aws list`

List configs.

**Example:**

```bash
npx openclaw-aws list
```

### `openclaw-aws current`

Show the current config.

**Example:**

```bash
npx openclaw-aws current
```

### `openclaw-aws use`

Select a config.

**Example:**

```bash
npx openclaw-aws use my-bot
```

## Configuration

Configuration is created with the `init` command, and stored per config in `.openclaw-aws/configs/<name>.json`.
The current selection is stored in `.openclaw-aws/current.json`.

**Example configuration:**

```json
{
  "version": "1.0",
  "aws": {
    "region": "us-east-1"
  },
  "instance": {
    "type": "t3.small",
    "name": "openclaw-my-bot"
  },
  "network": {
    "useDefaultVpc": true
  },
  "features": {
    "cloudWatchLogs": true
  },
  "openclaw": {
    "apiProvider": "anthropic-api-key"
  },
  "stack": {
    "name": "OpenclawStack-my-bot"
  }
}
```

If you want to use a named AWS CLI profile, you can add an optional `aws.profile` field manually.

## Multiple Bots (Configs)

To manage multiple bots, create one config per bot and switch between them:

```bash
npx openclaw-aws init --name bot-a
npx openclaw-aws init --name bot-b
npx openclaw-aws list
npx openclaw-aws use bot-b
npx openclaw-aws current
```

## Start/Stop (Cost Control)

Use `stop` to save costs when you don’t need the bot running, and `start` to resume.

```bash
npx openclaw-aws stop --name my-bot
npx openclaw-aws start --name my-bot
```

## Benefits & Setup

- **Ubuntu 24.04 LTS** on EC2
- **SSM-only access** (no SSH, no inbound ports)
- **Encrypted EBS** by default
- **IMDSv2 enforced** for metadata security

## Architecture

The deployment creates:

- **EC2 Instance** - Ubuntu 24.04 LTS, t3.small by default (or your chosen type)
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
npx openclaw-aws status
```

### "Config file not found"

Run the init command first:

```bash
npx openclaw-aws init
npx openclaw-aws list
npx openclaw-aws use my-bot
```

### Deployment fails

Check AWS credentials:

```bash
aws sts get-caller-identity
```

### Port forwarding fails

Ensure SSM plugin is installed and instance is ready:

```bash
npx openclaw-aws status
```

Restart instance if the gateway or SSM has crashed:

```bash
npx openclaw-aws restart
```

## Development

For developers contributing to openclaw-aws:

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/salza80/openclaw-aws.git
cd openclaw-aws

# 2. Use Node 22+
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

- **Node.js 22+**
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
