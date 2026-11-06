# Bedrock provider workflow

The provider operation adds optional instance-role authentication to a compatible existing OpenClaw installation. It preserves OpenRouter and other connections, existing model selections, credentials, agent settings and session overrides. Selecting a model is a separate explicit operation; installing a provider does not certify that paid inference will succeed.

## Fresh creation

```sh
openclaw-aws create research --provider bedrock --region eu-central-1 \
  --bedrock-region eu-central-1 --model 'amazon-bedrock/MODEL_OR_PROFILE' --yes
```

Use an available AWS model/profile identifier. Creation resolves its exact route before provisioning and displays the official plugin integrity, capabilities, restart consent and invocation/backing ARNs. `--yes` approves that setup as part of creation. AWS deployment and inference regions can differ. No model-provider API key or unused API-key parameter is created; Gateway authentication remains separate.

Once fresh installation and SSM checks finish, provisioning releases its lock and calls the shared provider workflow, then the shared model-selection workflow. Both bind the same immutable host/role/profile and approved route. Creation only reports ready after both confirm completion. These metadata/control-plane checks send no model prompts and do not certify paid inference.

If completion fails, the created deployment remains billable and inspectable. Keep the displayed operation IDs and use `providers inspect/reconcile` or `models inspect/reconcile` as appropriate. `deploy` skips an existing stack: it does not replay partial setup, rerun onboarding or reset the model. After resolving any pending operation, use explicit provider/model commands to continue. Do not create a second instance to repair the first.

## Enable an existing host

```sh
openclaw-aws providers enable-bedrock --name research \
  --inference-region eu-central-1 \
  --grant-model amazon-bedrock/<model-or-profile> \
  --allow-restart --accept-plugin-capabilities --yes
```

Repeat `--grant-model` for additional routes. The preview retains the host's existing managed route union, including grants needed by other agents/fallbacks, and shows exact invocation/backing-model ARNs. Removing unused grants or changing the whole host's inference region requires separate deliberate review. A discovery-only connection grants no model invocation permissions.

The hosting deployment region and Bedrock inference region have separate meanings. A regional or cross-region inference profile is resolved through AWS metadata rather than guessed from its name. Discovery does not send a model prompt. Bedrock inference usage is billed through AWS.

Use `--dry-run` to print the concrete immutable plan and discard its unexecuted IAM review. Declining a prompt also cancels that exact review. A create-review stack has no provisioned role policy; cancelling an update removes the change set, not the hosting stack.

## Ownership and setup

The shared controller verifies the immutable stack, instance, role and profile. It never resynthesizes the hosting EC2 stack to update model permissions. The auxiliary stack contains one scoped role policy, with current IAM drift/quota checks and exact change-set execution/readback.

The host independently proves its IMDSv2/STS role/EC2 identity and privately retrieves only its Gateway token. Setup uses the pinned official plugin through public OpenClaw lifecycle APIs. A conflicting installed plugin version/provenance, explicit plugin deny policy, conflicting AWS identity/endpoint inputs or unknown service environment files block automatic setup. Native install-policy failures are not bypassed.

A credential-free region-only AWS profile supplies native auth discovery while SDK credentials still come from IMDSv2. The managed service drop-in and native environment selectors point to that profile, contain no credentials/credential process, and do not copy an operator profile. Gateway authentication remains separate from provider authentication.

A controlled Gateway restart requires explicit consent and affects all agents sharing it. Native config changes use revision binding and preserve unrelated settings. Acknowledged activation failures attempt an owned rollback. Concurrent native edits or unacknowledged writes retain uncertainty instead of being overwritten/replayed.

Native model catalog publication is asynchronous. The worker makes one explicit metadata refresh, then waits for a native ready/access/unavailable outcome. The first empty page is not treated as success or failure. A ready empty policy-filtered inventory still permits no model selection. [Model management](model-management.md) owns persistent default/agent selection and its separate rollback/reconciliation.

## Interrupted setup

Keep the local `bedrock-operations` records and shared `model-pending` fence. The host has corresponding immutable requests, append-only events and maintenance ownership. Do not delete either hold based on age. The original code/request pins must remain available for inspection.

```sh
openclaw-aws providers inspect --name research --operation-id <uuid>
openclaw-aws providers reconcile --name research --operation-id <uuid> \
  --accept configured --yes
```

Configured acceptance requires current applied IAM grants, exact plugin provenance, managed role environment, authenticated native health and fresh discovery. It does not repeat plugin/configuration writes. A historical complete receipt with unavailable current observation remains explicitly unavailable.

If no native mutation started, `--accept previous` requires the original native revision and writes a terminal no-write receipt. This fences delayed original SSM delivery. It cannot roll back an already-started plugin/configuration mutation. Retained IAM review/applied-policy state still needs inspection; this acceptance alone is not proof that an interrupted CloudFormation action completed or was undone.

For a partial setup whose provider configuration remains unchanged, use:

```sh
openclaw-aws providers abort --name research --operation-id <uuid> --yes
```

Abort verifies the operation's durable preflight digest against the current healthy native configuration. It excludes only automatic last-touch metadata and this plugin's enablement/empty-config bookkeeping. It releases only this operation's maintenance and fences delayed delivery, without repeating a plugin/configuration write. Installed plugin files, managed role files and auxiliary IAM grants remain for inspection and a fresh explicit setup review.

Changed provider settings or unrelated native edits, missing original proof, unavailable health and another maintenance owner all prevent abort. Older worker records without this proof cannot be upgraded by guessing. Any recorded configuration-write intent also prevents abort: an unchanged observation cannot cancel a potentially in-flight native patch. Inspect that outcome and use configured-state reconciliation only after verifying the provider; unresolved changes retain their hold. An age-based hold deletion is never recovery.

Newly installed plugin files, managed role files and additive IAM grants can remain after a verified native rollback. Completion/refusal must describe that retained state. Real AWS/Bedrock inference acceptance is separate from native control-plane tests; no metadata result certifies model entitlement, organization restrictions or inference availability.
