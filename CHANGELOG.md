# @salza80/openclaw-aws

## 0.1.3

### Patch Changes

- 4cf5812: Update dependencies and development tooling. Require Node.js 22.13+ for the local CLI and use Node.js 24.22.2 with OpenClaw 2026.10.9 for new AWS deployments.

  Configure the gateway token before installing its service, and stop bootstrap on missing secrets or failed onboarding rather than reporting a successful setup.

## 0.1.2

### Patch Changes

- 6ca8786: Add tests and test coverage report
- 4c013eb: Update npm dependencies and docs.

## 0.1.1

### Patch Changes

- de46c7c: Remove t3.micro ec2 option - not working reliably with current setup
- 1631323: Add github actions for linting and publish. fix linting and prettier issues.
