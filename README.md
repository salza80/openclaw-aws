# Moltbotaws - OpenClaw AWS CDK Deployment

A secure, cloud-based deployment of the OpenClaw AI agent (moltbot) on AWS infrastructure using AWS CDK.

## Overview

This project automates the deployment of an OpenClaw conversational AI agent on AWS with security best practices:

- **Infrastructure as Code**: AWS CDK (TypeScript) defines all resources
- **Zero Trust Security**: No SSH, no open inbound ports, SSM-only access
- **Automated Setup**: EC2 instance with Node.js and OpenClaw CLI pre-installed
- **Secure Management**: All access audited via AWS Systems Manager
- **Private Dashboard**: Access OpenClaw UI via SSM port forwarding (not exposed to internet)

## Architecture

- **EC2 Instance**: Amazon Linux 2, t3.micro
- **Security**: No inbound rules, SSM-only access, least-privilege IAM
- **Networking**: Default VPC, public subnet (for outbound internet only)
- **Management**: AWS Systems Manager (SSM) Session Manager

## Prerequisites

Before deploying, ensure you have:

1. **AWS CLI** installed and configured with credentials
2. **AWS CDK** installed: `npm install -g aws-cdk`
3. **Node.js** (version 22 or higher)
4. **SSM Plugin** for AWS CLI:
   ```bash
   # macOS
   brew install --cask session-manager-plugin
   
   # Ubuntu/Debian
   curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
   sudo dpkg -i session-manager-plugin.deb
   
   # Windows (PowerShell as Administrator)
   # Download from: https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPluginSetup.exe
   ```

5. **Anthropic API Key** or OAuth credentials for Claude (recommended - get from https://console.anthropic.com/)
6. **(Optional) Brave Search API Key** for web search capabilities

## Quick Start Commands

This project includes npm scripts for common tasks. Here's a quick reference:

```bash
npm run deploy      # Build and deploy stack (no approval prompt)
npm run outputs     # Show all stack outputs (connection commands)
npm run connect     # Connect to instance via SSM
npm run dashboard   # Forward dashboard port (access at http://localhost:18789)
npm run status      # Check instance SSM status
npm run logs        # View instance console output
npm run destroy     # Remove all AWS resources
```

## Deployment

### 1. Install Dependencies

```bash
npm install
```

### 2. Bootstrap CDK (First Time Only)

If this is your first CDK deployment in this AWS account/region:

```bash
npx cdk bootstrap
```

### 3. Deploy the Stack

**Option A: Using the convenience script (recommended)**
```bash
npm run deploy
```

**Option B: Manual deployment**
```bash
npm run build
npx cdk deploy
```

The deployment will output three important values:
- **InstanceId**: Used for SSM connections
- **SSMConnectCommand**: Command to connect to the instance
- **SSMPortForwardCommand**: Command to access the dashboard

Save these outputs - you'll need them for the next steps.

**Quick access to outputs anytime:**
```bash
npm run outputs
```

## Post-Deployment Setup

### Step 1: Connect to the EC2 Instance via SSM

Wait 2-3 minutes after deployment for the instance to fully initialize, then connect:

**Option A: Using the convenience script (recommended)**
```bash
npm run connect
```

**Option B: Manual connection**
```bash
aws ssm start-session --target <INSTANCE_ID>
```

You should see a shell prompt like:
```
Starting session with SessionId: your-session-id
sh-4.2$
```

Switch to the ec2-user home directory:
```bash
sudo su - ec2-user
```

**Tip:** Check if the instance is ready:
```bash
npm run status
```

### Step 2: Run OpenClaw Onboarding

The OpenClaw CLI is already installed. Now run the interactive onboarding wizard:

```bash
openclaw onboard --install-daemon
```

The wizard will guide you through:

#### A. Choose Gateway Type
- Select **Local** (the instance will run its own gateway)

#### B. Configure Authentication
You'll need to provide LLM credentials. Recommended options:

**Option 1: Anthropic API Key (Recommended)**
- Select "Anthropic API Key" when prompted
- Enter your API key from https://console.anthropic.com/
- The wizard will store it securely in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

**Option 2: Claude OAuth (claude setup-token)**
- If you have Claude Code, run `claude setup-token` first
- The wizard will detect and import these credentials

**Option 3: OpenAI**
- Select OpenAI and enter your API key from https://platform.openai.com/

#### C. Configure Channels (Communication Platforms)

Choose which platforms you want to connect:

**WhatsApp** (Most Popular)
- Select WhatsApp when prompted
- You'll get a QR code in the terminal
- Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
- Scan the QR code
- Default: DM safety enabled (unknown contacts require pairing approval)

**Telegram**
- Create a bot via @BotFather on Telegram
- Copy the bot token
- Paste it when the wizard asks
- Your first DM will require pairing approval (see below)

**Discord**
- Create a Discord application at https://discord.com/developers/applications
- Create a bot and copy the token
- Paste it when the wizard asks

**Skip Channels** (Optional)
- You can skip channel setup and use only the web dashboard
- Configure channels later with: `openclaw channels configure`

#### D. Install Background Service
- Select **Yes** to install the systemd service
- This ensures OpenClaw runs automatically on boot
- **Important**: Must use Node runtime (NOT Bun) for WhatsApp/Telegram

#### E. Gateway Token
- The wizard generates a secure token automatically
- This token protects your dashboard and API
- Stored in `~/.openclaw/config/gateway.json` under `gateway.auth.token`

After onboarding completes, verify the service is running:

```bash
openclaw status
openclaw health
systemctl status openclaw
```

### Step 3: Approve DM Pairings (If Using WhatsApp/Telegram)

For security, unknown contacts are blocked by default until you approve them.

**When someone first messages your bot:**
1. They'll receive a pairing code (e.g., "4-digit code")
2. Messages won't be processed until you approve

**To approve:**

```bash
# List pending pairings
openclaw pairing list whatsapp
openclaw pairing list telegram

# Approve a specific pairing
openclaw pairing approve whatsapp <CODE>
openclaw pairing approve telegram <CODE>
```

After approval, the contact can chat with the bot normally.

### Step 4: Access the OpenClaw Dashboard

The OpenClaw dashboard runs on port 18789 but is NOT exposed to the internet. Access it securely via SSM port forwarding.

#### On Your Local Machine (New Terminal Window):

**Option A: Using the convenience script (recommended)**
```bash
npm run dashboard
```

**Option B: Manual port forwarding**
```bash
aws ssm start-session \
  --target <INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=18789,localPortNumber=18789"
```

**Keep this terminal window open** while you use the dashboard.

#### Access the Dashboard in Your Browser:

1. Open http://localhost:18789 in your browser
2. You'll see the OpenClaw Control UI
3. Click the settings icon (gear) in the top right
4. Paste your gateway token (from onboarding) into the auth field
5. Click Save/Connect

You can now:
- Chat with the agent directly in the browser
- View and manage channels
- Monitor conversations
- Configure agent settings

#### Get Your Gateway Token (If Needed):

If you need to retrieve the token later:

```bash
# On the EC2 instance via SSM:
cat ~/.openclaw/config/gateway.json | grep -A 1 '"token"'
```

## Common Operations

### Quick Commands (npm scripts)

```bash
# Connect to instance
npm run connect

# Access dashboard (then browse to http://localhost:18789)
npm run dashboard

# Check if instance is SSM-ready
npm run status

# View all stack outputs
npm run outputs

# View instance console logs
npm run logs
```

### Instance Management

#### Connect to Instance
```bash
# Quick connect (recommended)
npm run connect

# Or manually
aws ssm start-session --target <INSTANCE_ID>
```

#### Check Instance Status
```bash
# Check SSM connectivity
npm run status

# View console output (troubleshooting UserData execution)
npm run logs
```

### OpenClaw Operations (After Connecting via SSM)

#### Check OpenClaw Status
```bash
# Connect first, then switch to ec2-user
sudo su - ec2-user

# Check status
openclaw status --all
openclaw health
systemctl status openclaw
```

#### View OpenClaw Logs
```bash
# Connect via SSM first, then:
sudo su - ec2-user
journalctl -u openclaw -f
```

#### Restart OpenClaw Service
```bash
# Connect via SSM first, then:
sudo systemctl restart openclaw
systemctl status openclaw
```

#### Re-run Onboarding (Add Channels Later)
```bash
# Connect via SSM first, then:
sudo su - ec2-user
openclaw channels configure
# Or for WhatsApp QR login:
openclaw channels login
```

#### Send a Test Message
```bash
# From your local machine (with port forward active) or via SSM:
openclaw message send --target <phone_number> --message "Hello from OpenClaw"
```

#### Security Audit
```bash
# Connect via SSM first, then:
sudo su - ec2-user
openclaw security audit --deep
```

## Troubleshooting

### Instance Not Appearing in SSM

Wait 2-3 minutes after deployment for SSM agent to register. Check:

```bash
# List SSM-managed instances
aws ssm describe-instance-information --query "InstanceInformationList[?starts_with(InstanceId, 'i-')].[InstanceId,PingStatus,ComputerName]" --output table
```

If not listed after 5 minutes, check EC2 console for the instance logs.

### OpenClaw CLI Not Found

The UserData script installs it automatically. If missing:

```bash
# Connect via SSM, then:
sudo su - ec2-user
npm install -g openclaw@latest
```

### Gateway Not Starting

Check logs and auth configuration:

```bash
journalctl -u openclaw -n 50
openclaw health
cat ~/.openclaw/config/gateway.json
```

### Port Forward Fails

Ensure:
1. SSM plugin is installed locally
2. Instance has SSM connectivity (check above)
3. OpenClaw gateway is running on the instance: `systemctl status openclaw`

### WhatsApp QR Code Not Appearing

Ensure:
1. You're connected via SSM (interactive terminal required)
2. Running as ec2-user: `sudo su - ec2-user`
3. Gateway is using Node (NOT Bun): `ps aux | grep node`

### Messages Not Processing

Check pairing status:

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

## Security Considerations

- **No SSH**: All access via SSM (audited, session-recorded)
- **No Inbound Ports**: Security group has no inbound rules
- **IAM Least Privilege**: Instance role only has SSM permissions
- **Private Dashboard**: Access via SSM port forward only
- **DM Safety**: Unknown contacts blocked by default (pairing approval required)
- **Token Auth**: Gateway API protected by authentication token

## Cost Estimate

- **EC2 t3.micro**: ~$7.50/month (free tier: 750 hours/month for 12 months)
- **SSM**: No additional cost
- **Data Transfer**: Minimal (mostly outbound API calls)
- **LLM API Costs**: Variable (Claude, GPT, etc.)

**Total AWS Infrastructure**: ~$7.50/month after free tier

## Cleanup / Uninstalling

To completely remove the project and avoid ongoing charges:

### Option 1: Using npm script (Recommended)

```bash
npm run destroy
```

### Option 2: Manual cleanup

```bash
npx cdk destroy
```

Both methods will prompt for confirmation before deleting resources.

### What Gets Deleted

The destroy command will remove:
- ✅ EC2 instance (including all data on the instance)
- ✅ Security group
- ✅ IAM role
- ✅ CloudFormation stack

### What Doesn't Get Deleted

- ❌ Default VPC (it's looked up, not created by this stack)
- ❌ CDK bootstrap resources (S3 bucket, IAM roles) - these are reusable for other CDK projects

### Full Cleanup Checklist

If you want to completely remove everything:

1. **Destroy the stack**
   ```bash
   npm run destroy
   ```

2. **Remove CDK bootstrap (optional - only if not using CDK for other projects)**
   ```bash
   aws cloudformation delete-stack --stack-name CDKToolkit
   ```

3. **Verify all resources deleted**
   ```bash
   # Check for any remaining instances
   aws ec2 describe-instances --filters "Name=tag:Name,Values=moltbot-openclaw" --query "Reservations[].Instances[].[InstanceId,State.Name]" --output table
   
   # Check for the stack
   aws cloudformation describe-stacks --stack-name MoltbotawsStack
   # Should return: "Stack with id MoltbotawsStack does not exist"
   ```

4. **Remove local project files (if desired)**
   ```bash
   cd ..
   rm -rf moltbotaws
   ```

### Cost After Deletion

After running `npm run destroy`, you should incur:
- **$0/month** - All billable resources are removed
- If you kept CDK bootstrap: minimal S3 storage costs (typically < $0.01/month)

### Troubleshooting Cleanup

**If destroy fails:**

```bash
# Check what resources still exist
aws cloudformation describe-stack-resources --stack-name MoltbotawsStack

# Force delete via AWS Console:
# 1. Go to CloudFormation console
# 2. Select MoltbotawsStack
# 3. Delete (with "Retain" option if needed)
# 4. Manually delete any remaining resources from EC2 console
```

**If you can't find the instance:**

```bash
# List all your instances
aws ec2 describe-instances --query "Reservations[].Instances[].[InstanceId,Tags[?Key=='Name'].Value|[0],State.Name]" --output table
```

## Project Structure

```
moltbotaws/
├── bin/
│   └── moltbotaws.ts          # CDK app entry point
├── lib/
│   └── moltbotaws-stack2.ts   # Main stack definition
├── test/                       # Jest tests
├── cdk.json                    # CDK configuration
├── package.json                # Dependencies
└── README.md                   # This file
```

## Command Reference

### Convenience Scripts (npm)

| Command | Description |
|---------|-------------|
| `npm run deploy` | Build TypeScript and deploy stack (no approval prompt) |
| `npm run destroy` | Delete all stack resources |
| `npm run outputs` | Show all stack outputs (connection commands, instance ID) |
| `npm run connect` | Start SSM session to the instance |
| `npm run dashboard` | Forward port 18789 for dashboard access |
| `npm run status` | Check if instance is SSM-ready |
| `npm run logs` | View instance console output (UserData execution) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch for changes and compile |
| `npm run test` | Run Jest unit tests |

### CDK Commands (Manual)

| Command | Description |
|---------|-------------|
| `npx cdk deploy` | Deploy stack to AWS (with approval prompt) |
| `npx cdk destroy` | Delete all stack resources (with confirmation) |
| `npx cdk diff` | Compare deployed stack with current code |
| `npx cdk synth` | Emit CloudFormation template (for review) |
| `npx cdk ls` | List all stacks in the app |

### AWS CLI Commands (Direct)

These are used internally by the npm scripts, but can be run manually:

```bash
# Get instance ID
aws cloudformation describe-stacks \
  --stack-name MoltbotawsStack \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text

# Connect to instance
aws ssm start-session --target <INSTANCE_ID>

# Port forward for dashboard
aws ssm start-session \
  --target <INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=18789,localPortNumber=18789"

# Check SSM status
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=<INSTANCE_ID>" \
  --query 'InstanceInformationList[0].[InstanceId,PingStatus,PlatformName]' \
  --output table

# View console logs
aws ec2 get-console-output --instance-id <INSTANCE_ID> --output text
```

## Learn More

- **OpenClaw Documentation**: https://docs.openclaw.ai/
- **OpenClaw GitHub**: https://github.com/openclaw/openclaw
- **AWS CDK Guide**: https://docs.aws.amazon.com/cdk/
- **AWS Systems Manager**: https://docs.aws.amazon.com/systems-manager/

## Support

- OpenClaw Issues: https://github.com/openclaw/openclaw/issues
- AWS CDK Issues: https://github.com/aws/aws-cdk/issues

## License

This project is open source. OpenClaw is licensed under its own terms (see OpenClaw repository).
