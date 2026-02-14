# openclaw-aws

OpenClaw AWS is a CLI that makes it simple to provision and manage OpenClaw bots on AWS. It creates a minimal Ubuntu EC2 setup with secure SSM-only access.

## Quick Start

```bash
# Create a dedicated folder (recommended)
mkdir my-openclaw-bot
cd my-openclaw-bot

# Initialize your bot with interactive prompts
# This will generate a config file
npx @salza80/openclaw-aws init

# Deploy. -- That's it!
npx @salza80/openclaw-aws deploy

# Wait for deploy to finish. View the status of your bot
npx @salza80/openclaw-aws status
```

If you didn’t install globally, prefix commands with `npx @salza80/openclaw-aws`.

To access your bot:
```bash
# Open the dashboard to view in your browser (port forwarded via secure SSM - not public access)
openclaw-aws dashboard
# Opens http://localhost:18789 in your browser - short delay before it works - refresh browser after 5 seconds

# Or connect to the instance via SSM - for full terminal access
openclaw-aws connect
```

See the OpenClaw docs for ongoing configuration and usage guidance for your bot: [OpenClaw Documentation](https://docs.openclaw.ai/)

Managing multiple bots / instances:

```bash
# This will generate another config file
openclaw-aws init
# deploy it
openclaw-aws deploy

# List all bot configs
openclaw-aws list

# View status of the currently selected config
openclaw-aws status
# View status of all configs
openclaw-aws status --all

# See the currently selected config.
# Commands default to this config.
openclaw-aws current

# Select another config
openclaw-aws use <name>

# Run any command against a specific config or all configs with --name <name> or --all

# get help with commands
openclaw-aws --help
```

## Prerequisites

- **Node.js 20+**
- **AWS CLI v2 installed and authenticated** (SSO recommended)
  - Install AWS CLI v2: [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html)
  - Configure SSO: [AWS CLI SSO setup guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

## Commands

### `openclaw-aws init`

Interactive setup wizard to create a config.

**Example:**
```bash
openclaw-aws init
```

### `openclaw-aws deploy`

Deploy infrastructure to AWS.

**Example:**
```bash
openclaw-aws deploy
openclaw-aws deploy --name my-bot
openclaw-aws deploy --all
```

### `openclaw-aws status`

Check deployment and instance status.

**Example:**
```bash
openclaw-aws status
openclaw-aws status --all
```

### `openclaw-aws dashboard`

Forward port 18789 to access the OpenClaw dashboard locally.

**Example:**
```bash
openclaw-aws dashboard
```

### `openclaw-aws connect`

Connect to your EC2 instance via SSM.

**Example:**
```bash
openclaw-aws connect
```

### `openclaw-aws start`

Start a stopped instance.

**Example:**
```bash
openclaw-aws start
```

### `openclaw-aws stop`

Stop a running instance to save costs.

**Example:**
```bash
openclaw-aws stop
```

### `openclaw-aws restart`

Reboot the instance.

**Example:**
```bash
openclaw-aws restart
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

Configuration is created with the `init` command, and stored per config in `.openclaw-aws/configs/<name>.json`.
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
    "apiProvider": "anthropic-api-key"
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

Restart instance if the gateway or SSM has crashed:
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
