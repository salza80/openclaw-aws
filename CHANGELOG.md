# @salza80/openclaw-aws

## 0.2.0

### Minor Changes

- 62939ac: Add one-command named OpenClaw creation, explicit per-target AWS credentials shared by SDKs and subprocesses, bounded native command execution, independent dashboard ports, and desired/observed deployment metadata. Preserve existing init/deploy workflows and support hoisted CDK installations.
- 7107361: Add whole-team knowledge cloning from verified native backups into independent AWS deployments, with explicit fresh credentials, preview, inactive staging, deliberate activation, resumable ownership and cleanup. Share recovery delivery and service activation with restore.
- 825a964: Add an optional bundled local console for AWS deployment and team lifecycle, verified backup/archive recovery, provider/model controls and native OpenClaw UI access. Share CLI power and dashboard operations, preserve original operation identities across browser reconnects, and keep credentials on the backend.
- bed2735: Add native multi-agent teams on one AWS EC2/Gateway, with declared role instructions, communication policies, model selections, provider references and resumable setup. Reuse whole-installation backup/archive/restore for team recovery with independent role metadata and native coordination-policy verification before activation.
- b76157b: Add optional instance-role Amazon Bedrock setup for fresh and running claws, plus native default/agent model listing, selection and interrupted-operation recovery without rebuilding EC2. Preserve OpenRouter and direct-provider credentials. Scope additive model permissions through reviewed policy-only stacks, recreate role connections during restore/clone, and keep metadata discovery separate from paid inference.
- 656292c: Add independent versioned AWS recovery vaults and native encrypted OpenClaw backup creation, discovery and exact-version verification. Preserve recovery keys after source deletion, scope host access by source prefix, and support clean-client recovery reads without local deployment configuration.
- e94a48a: Restore verified native backups onto fresh AWS infrastructure without the original instance, secrets or local configuration. Preserve the full agent roster, rotate Gateway credentials, rebuild declared pinned plugin dependencies, and activate only after validation with integrations paused and conversations archived for deliberate native reactivation. Add restartable restore journals and ownership-checked cleanup for failed or unwanted targets.
- b18c851: Add whole-deployment archive, inspection, owned abort and clean-client resume. Keep the final native recovery point independently verifiable, persistently hold the source before teardown, and retain durable recovery receipts when deletion is interrupted.

### Patch Changes

- 4cf5812: Update dependencies and development tooling. Require Node.js 22.13+ for the local CLI and use Node.js 24.22.2 with OpenClaw 2026.10.9 for new AWS deployments.

  Configure the gateway token before installing its service, and stop bootstrap on missing secrets or failed onboarding rather than reporting a successful setup.

- 9a666cc: Preserve secrets and configs when a stack lookup fails, and restore the caller's AWS profile between configs in batch operations.

  Implement optional CloudWatch collection of bootstrap and gateway logs with scoped permissions and 30-day retention for new deployments. Update globals while keeping TypeScript on version 6.

- 22d197e: Install OpenClaw 2026.11.1 using the pinned official private-prefix installer with Node.js 24.22.2. Remove unconditional NVM, Homebrew, GCC, and Docker setup, and preserve API-provider compatibility through native environment secret references.

  Wait for authenticated Gateway health and CloudFormation readiness signals, then confirm SSM access before deployment succeeds. Bound runtime SSM parameter reads to the deployment's secrets, retain optional CloudWatch logging, and support required Cloudflare Gateway metadata. Existing deployed instances are not upgraded or replaced by updating the CLI.

  Preserve failed fresh deployments and bounded private diagnostics for investigation, with explicit cleanup guidance. Keep legacy Cloudflare configurations usable for lifecycle commands and deletion without requiring new-instance metadata.

- 95d1168: Check EC2 memory and architecture before creating bootstrap or deployment resources. Reject hosts below this deployment's supported 2 GiB memory floor and ARM types incompatible with the x86_64 installation. Preserve valid AWS instance type names without depending on the bundled CDK enum. Replace stale monthly-price labels with capacity guidance and document the measured baseline.

  Configure persistent private swap on fresh hosts with at most 2 GiB RAM, following upstream small-host guidance while retaining existing active swap.

## 0.1.2

### Patch Changes

- 6ca8786: Add tests and test coverage report
- 4c013eb: Update npm dependencies and docs.

## 0.1.1

### Patch Changes

- de46c7c: Remove t3.micro ec2 option - not working reliably with current setup
- 1631323: Add github actions for linting and publish. fix linting and prettier issues.
