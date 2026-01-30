# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-30

### Added

#### Foundation
- Project restructuring to `src/cli` and `src/cdk` directories
- TypeScript configuration for ESM modules
- Package configuration for GitHub Packages
- Comprehensive dependency installation (yargs, prompts, ora, chalk, AWS SDKs)

#### Core Commands
- `openclaw-aws init` - Interactive configuration wizard with validation
  - Project name validation (lowercase, hyphens only)
  - AWS region selection from predefined list
  - EC2 instance type selection (t3.micro, small, medium, large)
  - Instance name customization
  - CloudWatch Logs toggle
  - Non-interactive mode with `--yes` flag
  
- `openclaw-aws deploy` - Infrastructure deployment
  - Reads configuration from `.openclaw-aws/config.json`
  - Shows deployment plan summary
  - Confirmation prompt (skippable with `--auto-approve`)
  - AWS credentials validation
  - CDK bootstrap check
  - Progress spinner with status updates
  - CloudFormation outputs saved locally
  - Error handling for common issues (credentials, bootstrap)
  
- `openclaw-aws destroy` - Resource cleanup
  - Stack status check before deletion
  - Detailed list of resources to be deleted
  - Confirmation via typing "DELETE"
  - Force mode with `--force` flag
  - Option to keep config file with `--keep-config`
  - Cost summary after deletion

#### Helper Commands
- `openclaw-aws connect` - SSM session connection
  - Automatic instance ID lookup from CloudFormation
  - SSM connectivity check
  - Auto-wait for instance readiness (up to 3 minutes)
  - Direct SSH-like session with proper terminal passthrough
  
- `openclaw-aws onboard` - Onboarding assistance
  - Pre-connection guide with checklist
  - Links to API key sources (Anthropic, Brave Search)
  - Step-by-step wizard instructions
  - Automatic connection to instance
  
- `openclaw-aws dashboard` - Port forwarding for web UI
  - Port 18789 forwarding to localhost
  - Automatic browser opening (optional with `--no-open`)
  - Cross-platform browser detection (macOS, Linux, Windows)
  - Graceful shutdown on Ctrl+C
  - Keep-alive process management
  
- `openclaw-aws status` - Deployment status check
  - Stack status with color-coded output
  - Instance status (running/stopped/terminated)
  - SSM connectivity status
  - Quick command suggestions
  - Helpful error messages if not deployed
  
- `openclaw-aws outputs` - CloudFormation outputs display
  - Pretty-printed stack outputs
  - Formatted AWS CLI commands
  - Quick command reference

#### Utilities
- Config management (`src/cli/utils/config.ts`)
  - JSON config file reading/writing
  - Config path resolution
  - Outputs file management
  - Error handling with helpful messages
  
- AWS helpers (`src/cli/utils/aws.ts`)
  - Instance ID lookup from CloudFormation
  - SSM status checking
  - SSM readiness waiting with polling
  - Stack status retrieval
  - Stack outputs fetching
  - Error handling for missing resources
  
- Logger (`src/cli/utils/logger.ts`)
  - Colored console output (info, success, warn, error)
  - Formatted title boxes
  - Multi-line content boxes
  
- Validation (`src/cli/utils/validation.ts`)
  - Project name validation (lowercase, hyphens, length)
  - Instance name validation (alphanumeric, hyphens, length)
  - AWS region presets
  - Instance type presets with pricing

#### CDK Infrastructure
- Refactored CDK stack (`src/cdk/stack.ts`)
  - Parameterized configuration
  - Dynamic instance type parsing
  - Configurable Node.js version
  - Custom tags (Name, Project, ManagedBy)
  - Comprehensive CloudFormation outputs
  
- CDK app (`src/cdk/app.ts`)
  - Config file loading
  - Instance type parsing
  - Dynamic stack creation with config
  - Environment setup (region, account)

#### Documentation
- Comprehensive README.md
  - Quick start guide
  - Prerequisites list
  - Installation instructions (GitHub Packages, Git, Local)
  - Command reference with examples
  - Configuration file format
  - Architecture diagram (text)
  - Security features
  - Cost breakdown
  - Troubleshooting section
  
- SETUP.md guide
  - Step-by-step setup instructions
  - GitHub Packages publishing guide
  - Local testing instructions
  - Usage examples
  
- CHANGELOG.md (this file)
- LICENSE (MIT)

### Changed
- Project name from `moltbotaws` to `openclaw-aws`
- Package structure from flat to organized `src/` directory
- TypeScript module system to ESM (ES2022)
- CDK stack from hardcoded to parameterized
- Binary entry point from `bin/moltbotaws.js` to `dist/cli/index.js`

### Removed
- Old npm scripts (deploy, destroy, connect, dashboard, status, logs)
- Test-related dependencies (jest, ts-jest) - will be added back when writing tests

### Security
- SSM-only access (no SSH)
- Zero inbound security group rules
- Least-privilege IAM roles
- Private dashboard (port forwarding only)
- Audited access via AWS Systems Manager

## [Unreleased]

### Planned Features
- `openclaw-aws logs` - Stream CloudWatch logs
- `openclaw-aws backup` - Create instance snapshot
- `openclaw-aws restore` - Restore from snapshot
- `openclaw-aws update` - Update stack with new config
- `openclaw-aws list` - List all deployments
- Multiple project management
- Template system (minimal, standard, production)
- Automated tests (unit + integration)
- CI/CD pipeline (GitHub Actions)
