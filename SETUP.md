# Setup Guide for openclaw-aws

## Implementation Complete! ✅

All Week 1 and Week 2 tasks have been completed:
- ✅ Foundation: Project restructuring, dependencies, TypeScript config
- ✅ Core Commands: init, deploy, destroy
- ✅ Helper Commands: connect, onboard, dashboard, status, outputs
- ✅ Build successful

## Next Steps to Use This Package

### 1. Update Package Name

Replace `YOUR_GITHUB_USERNAME` in these files:
- `package.json` (line 2, 13-18)
- `README.md` (multiple locations)
- `src/cli/index.ts` (line 28)

```bash
# Find your GitHub username
git config --get user.name

# Or just set it directly in package.json
```

### 2. Test Locally

```bash
# Make sure node is in PATH (you have nvm installed)
export PATH="/Users/smclean/.nvm/versions/node/v22.20.0/bin:$PATH"

# Or add to your ~/.zshrc:
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.zshrc
source ~/.zshrc
nvm use 22

# Link the package locally
npm link

# Test the CLI
openclaw-aws --help
openclaw-aws init
```

### 3. Create GitHub Repository

```bash
# Initialize git (if not already)
git init

# Add files
git add .
git commit -m "Initial commit: openclaw-aws CLI"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/openclaw-aws.git
git branch -M main
git push -u origin main
```

### 4. Publish to GitHub Packages

**A. Generate GitHub Personal Access Token**
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `write:packages` and `read:packages` permissions
3. Save the token securely

**B. Configure npm for GitHub Packages**
```bash
# Login to GitHub Packages
npm login --registry=https://npm.pkg.github.com

# When prompted:
# Username: YOUR_GITHUB_USERNAME
# Password: YOUR_GITHUB_TOKEN (paste token)
# Email: (your email)
```

**C. Publish**
```bash
# Build first
npm run build

# Publish
npm publish
```

### 5. Install from GitHub Packages

On any machine with access to your GitHub repo:

```bash
# Add GitHub registry to .npmrc
echo "@YOUR_GITHUB_USERNAME:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc

# Install globally
npm install -g @YOUR_GITHUB_USERNAME/openclaw-aws

# Or install from git directly (no token needed if private repo with SSH key)
npm install -g git+ssh://git@github.com/YOUR_GITHUB_USERNAME/openclaw-aws.git
```

## Usage Example

```bash
# 1. Initialize project
mkdir my-openclaw-project
cd my-openclaw-project
openclaw-aws init

# 2. Deploy to AWS
openclaw-aws deploy

# 3. Wait 2-3 minutes, then onboard
openclaw-aws onboard
# On the instance, run: openclaw onboard --install-daemon

# 4. Access dashboard
openclaw-aws dashboard
# Opens http://localhost:18789

# 5. When done, destroy
openclaw-aws destroy
```

## File Structure

```
openclaw-aws/
├── src/
│   ├── cli/
│   │   ├── index.ts              ← Main CLI entry
│   │   ├── commands/             ← All 8 commands
│   │   ├── utils/                ← Helpers (config, aws, logger)
│   │   └── types/                ← TypeScript types
│   └── cdk/
│       ├── app.ts                ← CDK app (reads config)
│       └── stack.ts              ← Parameterized stack
├── dist/                         ← Build output (after npm run build)
├── templates/                    ← Config template
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
└── SETUP.md                      ← This file
```

## What Was Built

### Foundation (Week 1)
- ✅ Restructured to src/ directory with cli/ and cdk/ subdirectories
- ✅ Updated package.json for GitHub Packages publication
- ✅ Configured TypeScript for ESM modules
- ✅ Installed all dependencies (yargs, prompts, ora, chalk, AWS SDKs, execa)
- ✅ Created utility modules (config, aws, logger, validation)
- ✅ Created TypeScript type definitions

### Core Commands (Week 1)
- ✅ **init** - Interactive wizard with prompts for all configuration
- ✅ **deploy** - CDK deployment with progress spinner and error handling
- ✅ **destroy** - Safe deletion with confirmation and option to keep config

### Helper Commands (Week 2)
- ✅ **connect** - SSM session with auto-wait for instance readiness
- ✅ **onboard** - Pre-connection guide with OpenClaw setup instructions
- ✅ **dashboard** - Port forwarding with browser auto-open
- ✅ **status** - Formatted display of stack, instance, and SSM status
- ✅ **outputs** - Pretty-printed CloudFormation outputs

### Refactored CDK
- ✅ **Parameterized stack** - Reads from config file
- ✅ **Dynamic CDK app** - Loads config and builds stack
- ✅ **Proper outputs** - Instance ID, SSM commands, etc.

## Troubleshooting

### "node: not found" when building
```bash
# Add nvm to your shell
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22
```

### "openclaw-aws: command not found" after npm link
```bash
# Check where npm global bin is
npm bin -g

# Add to PATH if needed
export PATH="$(npm bin -g):$PATH"
```

### Can't publish to GitHub Packages
- Make sure package name starts with `@YOUR_GITHUB_USERNAME/`
- Check token has `write:packages` permission
- Ensure you're logged in: `npm login --registry=https://npm.pkg.github.com`

## What's Next?

You can now:
1. Test the CLI locally with `npm link`
2. Deploy a real instance to AWS
3. Publish to GitHub Packages for private use
4. Add more features (backup, update, logs, etc.)
5. Eventually publish to public npm when ready

## Questions?

- Check README.md for full documentation
- OpenClaw docs: https://docs.openclaw.ai/
- AWS CDK docs: https://docs.aws.amazon.com/cdk/
