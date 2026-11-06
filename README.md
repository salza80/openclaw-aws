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

Create a named claw with one command after setting its provider credential:

```bash
export OPENROUTER_API_KEY=your-api-key
npx openclaw-aws create personal --provider openrouter --region eu-central-1
# Noninteractive: add --yes to approve provisioning and required CDK bootstrap.
# Optional: --profile work --instance-type t3a.small --model openrouter/openai/gpt-4.1-nano
npx openclaw-aws status --name personal --runtime
```

`create` accepts the providers listed by `--help`, including existing full names such as `openrouter-api-key`. It inherits region, profile, instance type and provider/model defaults from the current configuration; explicit options take precedence. A different provider does not inherit the previous provider's model. Missing credentials fail before provisioning; local names, existing AWS stacks and retained secret names are checked before saving the new configuration. Cancelling deployment leaves the configuration available for `deploy`. Fresh deployment never overwrites an existing SSM secret; inspect retained resources and explicitly clean up before retrying a failed creation.

For Amazon Bedrock, choose `--provider bedrock --bedrock-region eu-central-1 --model amazon-bedrock/<model-or-inference-profile-id>`. Bedrock uses the new instance's role and AWS billing, with no model API key. Creation displays the exact model route/backing permissions and plugin capability consent. AWS hosting and inference regions are separate. OpenRouter remains available alongside Bedrock; see [provider setup](docs/bedrock-provider-workflow.md).

The existing two-step setup remains available:

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
# Selects a free local port and privately passes the token to your browser

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

This package targets fresh installations and the current pinned OpenClaw schema. It does not migrate previous package versions or legacy native settings. Destroying a deployment deletes its instance data; retain a verified backup before removal.

## EC2 sizing

The default is `t3.small` (2 GiB), which has passed installation and reboot checks for a basic Gateway. Before creating new deployment resources, the CLI checks AWS instance metadata for x86_64 support and at least this project's supported 2 GiB minimum. Although upstream documents a lower absolute minimum, our 1 GiB tests did not pass the complete management workload. Smaller and ARM instances are unsupported by this bootstrap. Existing configurations remain manageable without resizing their instances.

Fresh hosts with 2 GiB RAM or less receive a private 2 GiB swapfile on their encrypted root disk, persisted across reboot with swappiness 10. Existing active swap is retained. An inactive file at the managed swap path stops setup for inspection rather than being overwritten. This does not modify already deployed hosts or establish that every 1 GiB workload is reliable.

See the [sizing report](https://github.com/salza80/openclaw-aws/blob/main/docs/ec2-sizing.md) for current Frankfurt compute prices, measured memory, additional charges and the minimum-size test plan. Instance prices vary by region; the setup menu does not quote a universal monthly cost.

## Commands

### `openclaw-aws models`

Read the running Gateway's native inventory and change its persistent default or one existing agent's model through SSM:

```bash
openclaw-aws models current --name my-bot --json
openclaw-aws models list --name my-bot --agent researcher --provider openrouter --json
openclaw-aws models set 'openrouter/MODEL_FROM_LIST' --name my-bot --agent researcher --dry-run
openclaw-aws models set 'openrouter/MODEL_FROM_LIST' --name my-bot --agent researcher --yes
openclaw-aws models inspect --name my-bot --operation-id <operation-uuid> --json
openclaw-aws models reconcile --name my-bot --operation-id <operation-uuid> --accept requested --yes
```

Copy an exact model reference from `models list`. Omit `--agent` to target Gateway defaults; explicit sibling agent settings and session overrides remain distinct. The provider must already be configured. These commands do not send model prompts or replace EC2/storage. A Gateway with native reload disabled requires explicit `--allow-restart` consent. See [model management](docs/model-management.md) for policy, first-use tool delivery and recovery after interrupted commands.

### `openclaw-aws providers`

Enable optional Bedrock on a running claw without replacing its instance or disk:

```sh
openclaw-aws providers enable-bedrock --name my-bot --inference-region eu-central-1 --dry-run
openclaw-aws providers enable-bedrock --name my-bot --inference-region eu-central-1 --allow-restart --accept-plugin-capabilities --yes
```

Review the separate role-policy change set, pinned native plugin and restart before applying. Provider setup preserves other connections and current model choices. Then use `models list` and `models set` to select a model; Bedrock selection previews any additional invocation permissions. Discovery is a metadata check and does not prove paid inference access. See [provider recovery and inspection](docs/bedrock-provider-workflow.md) for interrupted operations.

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

Forward the native Gateway port 18789 through SSM to an automatically selected free local port. Multiple deployments can have simultaneous tunnels. Readiness comes from the child Session Manager listener after a successful native health check.

**Example:**

```bash
npx openclaw-aws dashboard --name personal
npx openclaw-aws dashboard --name research --local-port 19876
npx openclaw-aws dashboard --no-open
```

Tokens are omitted from terminal output by default and passed to the browser in a URL fragment. For an explicitly printed private authenticated URL, use `--show-token`; keep that output private. Requested ports that are occupied and child process failures produce an error.

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

### Independent recovery vaults

```bash
openclaw-aws vault create primary --region eu-central-1 --profile operator --yes
openclaw-aws vault inspect s3://bucket/vault-prefix --region eu-central-1 --profile operator --json
```

Vaults keep private, versioned S3 storage and a retained Secrets Manager passphrase independently of deployment stacks. An existing bucket can be registered with `vault register <s3-uri> --key-arn <independent-secret-arn>` and explicit region/profile. Registration checks ownership, encryption, public-access protection, TLS and retention without changing existing bucket policies. Storage, old versions and retained keys remain billable after source deletion.

Create a recovery point from a named deployment, then discover and verify it using only the vault location and operator AWS access:

```bash
openclaw-aws backup create --name my-bot --vault s3://bucket/vault-prefix --label before-holiday --yes
openclaw-aws backup list --vault s3://bucket/vault-prefix --region eu-central-1 --profile operator --json
openclaw-aws backup inspect <point-id> --vault s3://bucket/vault-prefix --region eu-central-1 --profile operator --json
openclaw-aws backup verify <point-id> --vault s3://bucket/vault-prefix --region eu-central-1 --profile operator --json
```

Capture briefly stops the Gateway, uses native OpenClaw encryption and full remote verification, then restores the previous service state. It covers the complete native agent roster, declared workspaces, state and recoverable credentials. An incomplete capture never becomes a completed recovery point. Retry an interrupted operation with its printed `--operation-id`; maintenance ownership is never cleared by age. The independently retained vault and key survive destruction of the source instance and source SSM parameters. Save the vault URI and keep operator access to both resources.

The first backup release supports our pinned OpenClaw/Node installation and default native service paths; it does not silently upgrade older instances. Native runtime caches and volatile queues are omitted. Restored sessions can still contain interrupted work that OpenClaw would automatically resume; review recovery, channels and schedules before starting restored state. External secret commands, uncaptured credential files and unresolved native references prevent full recovery certification. Destroy removes the source's separately attached backup access policy before its IAM role; denied cleanup stops destruction. Vault creation alone does not create a recovery point. See [native backup integration](docs/native-backup-transport.md) for installation, key retention, operator permissions and verification boundaries.

The restore workflow uses an explicit completed backup ID and independent vault:

```sh
openclaw-aws restore --from <backup-uuid> --vault s3://my-vault/recovery --region eu-central-1 --name recovered --yes
openclaw-aws restore activate --operation-id <restore-uuid> --yes
openclaw-aws restore resume --operation-id <restore-uuid> --yes
openclaw-aws restore inspect --operation-id <restore-uuid> --json
# Explicitly delete a failed/unwanted target while retaining its backup:
openclaw-aws restore cleanup --operation-id <restore-uuid> --yes
```

Staging creates an inactive host; activation starts a validated Gateway with channels, schedules, hooks and restored sessions still paused. Add `--activate` to the first command to request both steps. `--target-region`, `--target-profile`, `--instance-type` and `--volume-gib` override the new target settings within the same account. The disk includes space for staged extraction. Resume verifies an existing operation and reuses its exact code/request versions; it does not create another instance when the original target is missing. Inspection reports the saved operation state. Cleanup verifies operation ownership and removes imported provider keys as well as the Gateway credential; the independent backup remains. After activation, review pairing and integrations in the native dashboard and restore selected archived conversations or create a new thread to deliberately restart reviewed work. See the [reconnection runbook](docs/native-backup-transport.md#reconnection-and-reviewed-work). The fresh-host AWS acceptance drill is deferred; the complete EC2 restore path has not yet been demonstrated.

### Independent knowledge clones

Clone a saved installation into one new EC2/Gateway host with fresh native ownership and credentials. The original can remain live. All saved agent roles share the new host; their valid IDs, internal delegation relationships, supported model settings, workspace memory and file-backed skills are preserved. History, source credentials and opaque native stores are excluded.

```sh
openclaw-aws clone preview --from <backup-uuid> --vault s3://my-vault/recovery --region eu-central-1 --name research-copy --json
openclaw-aws clone --from <backup-uuid> --vault s3://my-vault/recovery --region eu-central-1 --name research-copy --key-env MY_OPENROUTER_KEY --yes
openclaw-aws clone activate --operation-id <clone-uuid> --yes
openclaw-aws clone inspect --operation-id <clone-uuid> --json
openclaw-aws clone resume --operation-id <clone-uuid> --yes
openclaw-aws clone cleanup --operation-id <clone-uuid> --yes
```

Preview lists selected/omitted content before creating target resources. Supply new API-provider credentials explicitly through a named environment variable, private interactive entry, or deliberate SSM reuse (`--reuse-ssm /source/api-key`). Use `--provider bedrock` for keyless role setup; the saved inference region is retained unless overridden by `--bedrock-region`. Mixed teams still need explicit keys for their API providers. Bedrock permissions cover the copied default/agent/fallback policy, excluding conversation history. The default primary credential provider is OpenRouter. Staging leaves the Gateway masked; `--activate` requests activation after safety validation and removal of source-backup/key access. Channels, external connections, schedules, hooks and indexing remain disconnected. See the [clone runbook](docs/independent-clones.md) for policy, recovery, IAM permissions and reconnection. Local/native validation is covered; live EC2 clone acceptance has not been run.

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

Select a named AWS profile with `init --profile work`, `create --profile work`, or the optional `aws.profile` configuration field. An explicit profile takes precedence over environment credentials. Without a selected profile, environment credentials are captured once; otherwise the shell profile or default profile is used. Operations resolve account and credentials independently without modifying the shell environment, including overlapping targets. SDK calls and CDK/AWS child processes receive the same identity. CDK uses a captured configuration and private working/home directories, so edits during an operation, unrelated CDK settings and concurrent assemblies cannot retarget the deployment. Expiring credentials refresh through the original source and are checked for changes to the AWS account or IAM principal; a renewed session for the same role is allowed. If an SSO login expired while the AWS CLI still holds a valid role credential, the CLI can export it privately for the shared context. Sign in again when credentials cannot cover a bounded CDK operation. Temporary credentials need a known expiration for a long CDK operation; use a refreshable profile, or provide the actual `AWS_CREDENTIAL_EXPIRATION` timestamp with temporary environment credentials.

`status --runtime` reads the native OpenClaw version and resolved default model without inference. `.openclaw-aws/deployments/<name>.json` records the CloudFormation identity and separates desired settings from observations. Differences are reported without changing native UI settings. Existing v1 configs remain readable; inspection does not migrate AWS resources. The context rejects changes to a saved account, region or stack name; destruction and inspection also check the saved CloudFormation identity. Shared mutations use `.openclaw-aws/locks/`; after a crashed process, verify no operation is active before removing its stale lock. See [repository guidance](AGENTS.md) for layer ownership.

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
