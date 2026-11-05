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

Use `@salza80/openclaw-aws` only when installing the package. The CLI command itself is `openclaw-aws`.

- Local install: `npx openclaw-aws <command>`
- Global install: `openclaw-aws <command>`

## Prerequisites

- **Node.js 22.13+** for the local CLI (Node.js 24.22.2 recommended)
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

## OpenClaw version and existing deployments

New deployments install **OpenClaw 2026.11.1** with **Node.js 24.22.2** on Ubuntu 24.04. The official private-prefix installer and its policy helper are fetched from an immutable upstream revision and checked against recorded SHA-256 hashes. The installer applies the supported npm lifecycle policy. Runtime files live under the ubuntu user's private OpenClaw prefix; no NVM, Homebrew, GCC, or Docker is installed by default.

CloudFormation waits up to 20 minutes for bootstrap and authenticated Gateway health before reporting success. The CLI then confirms that the instance is reachable through SSM. An installation, onboarding, health, or readiness-signal failure fails deployment instead of reporting an unfinished Gateway as ready. Very early failures before AWS CLI installation can surface as the CloudFormation readiness timeout; inspect stack events and bootstrap diagnostics.

Fresh deployments preserve failed resources instead of automatically rolling them back, so the instance and its diagnostics remain available for inspection. After investigating a failed deployment, run `openclaw-aws destroy --name <name>` to remove it. EC2, disk, public IPv4, and log charges can continue until cleanup completes.

When onboarding or health output is available after a bootstrap failure, the instance retains redacted diagnostics under `/var/log/openclaw-bootstrap/` and prints that directory's path in cloud-init output. Inspect them through SSM with `sudo`; the directories are root-only and their files are private. Retention is limited to three failures and 64 KiB per output file. Temporary SSM credential responses and environment files are always removed. If credential redaction cannot be initialized, diagnostic contents are omitted. Failed readiness-signal delivery also retains available diagnostics; a successful bootstrap removes its temporary diagnostics.

Provider keys and the Gateway token are retrieved from their existing SSM SecureString paths at runtime and persisted privately for native environment secret references. Their values are not embedded in UserData or onboarding command arguments. The SSM agent policy is bounded so its wildcard parameter-read grant cannot expose other deployments' parameters. Optional CloudWatch collection retains its existing scope and retention.

Bootstrap refuses an existing `.env` without an OpenClaw config rather than overwriting partial credentials. Back up that file and complete onboarding manually or move it aside before explicitly retrying setup.

Docker-based agent sandboxes are optional additional setup. Follow the [OpenClaw sandbox guide](https://docs.openclaw.ai/gateway/sandboxing) when enabling them; this CLI's default is a native Gateway installation.

Updating this CLI does not upgrade an existing instance. The `deploy` command skips stacks that already exist. To inspect an existing installation:

```bash
npx openclaw-aws connect --name my-bot

# On the instance, as the ubuntu user:
node --version
openclaw --version
```

Back up your OpenClaw state before upgrading an existing installation, then follow the [OpenClaw update guide](https://docs.openclaw.ai/install/updating). When upgrading from Node.js 22, update Node first and refresh the gateway service so it uses the new runtime. Destroying a deployment deletes its instance data and is not an upgrade procedure.

## EC2 sizing

The default is `t3.small` (2 GiB), which has passed installation and reboot checks for a basic Gateway. Before creating new deployment resources, the CLI checks AWS instance metadata for x86_64 support and at least OpenClaw's documented 1 GiB minimum. The complete deployment has not yet been verified on 1 GiB; 512 MiB nano and ARM instances are unsupported by this bootstrap. Existing configurations remain manageable without resizing their instances.

See the [sizing report](https://github.com/salza80/openclaw-aws/blob/main/docs/ec2-sizing.md) for current Frankfurt compute prices, measured memory, additional charges and the minimum-size test plan. Instance prices vary by region; the setup menu does not quote a universal monthly cost.

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

If the stack lookup fails because of permissions, credentials, or connectivity, destruction stops without deleting stored secrets or local configs. Cleanup of orphaned secrets only proceeds when CloudFormation confirms the stack is missing.

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
Each config uses its own profile. A config without `aws.profile` uses the original shell profile or default AWS credential chain, including during `--all` operations.

### Cloudflare AI Gateway setup

This provider also requires a Cloudflare account ID and Gateway ID. Interactive setup asks for both. For noninteractive setup:

```bash
npx openclaw-aws init --name cloudflare --yes \
  --api-provider cloudflare-ai-gateway-api-key \
  --cloudflare-account-id <32-character-account-id> \
  --cloudflare-gateway-id <gateway-id>
```

Existing configs can set `openclaw.cloudflare.accountId` and `openclaw.cloudflare.gatewayId` explicitly. Missing metadata is rejected before provisioning. Existing provider/config names and local API-key environment variables remain compatible; the bootstrap maps legacy Kimi Code, MiniMax, and OpenCode choices to the selected upstream release.

### CloudWatch Logs

For new deployments, `features.cloudWatchLogs: true` installs and starts the CloudWatch agent. Logs are sent to `/openclaw/<stack-name>` with 30-day retention and separate streams per instance for bootstrap output, cloud-init diagnostics, and the OpenClaw gateway. The gateway writes its file log to `/home/ubuntu/.openclaw/logs/gateway.log`.

The instance can write only to its deployment's log group. The log group is deleted when the stack is destroyed. CloudWatch ingestion and storage incur AWS charges; set `features.cloudWatchLogs` to `false` to disable collection.

Use `openclaw-aws outputs` to see `LogGroupName`. Updating this CLI does not install the agent on existing instances, because `deploy` skips existing stacks.

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
- **CloudWatch Logs** (optional) - Collects bootstrap and gateway logs with 30-day retention

## Security

- **No inbound ports** (SSM access only)
- **No SSH** (disabled by design)
- **Encrypted storage** with EBS
- **SSM sessions** are auditable in CloudTrail

### Troubleshooting - Instance not appearing in SSM

New deployments confirm SSM access before reporting success. For an older or restarted instance, check status:

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

# 2. Use the project's Node version
nvm install
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

- **Node.js 24.22.2** via `.nvmrc` (the local CLI supports Node.js 22.13+)
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
