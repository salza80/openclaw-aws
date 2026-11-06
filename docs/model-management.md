# Native model management

`models current` reads the configured primary, published default for new sessions, fallback count, native reload setting and observation time. `models list` returns a bounded page of the running Gateway's policy-filtered inventory. Use its `nextOffset` with `--offset`; `--limit` accepts 1–50 rows. Listing does not refresh provider acquisition or invoke a model. Unknown capabilities remain unknown, and metadata does not certify successful inference.

`models set <provider/model>` previews an existing hosting deployment and either Gateway defaults or an explicit `--agent`. It binds the selected account, region, immutable stack/instance/role/profile, native configuration revision and worker code to that preview. Approval applies only that plan. A stale revision or changed host is refused. Native persistent settings, existing session selections, API credentials, memory and workspace state have separate ownership; changing the model does not recreate infrastructure or retarget provider-secret cleanup.

The selected model must be in the native policy-filtered catalog. An administrative configuration patch must not bypass the native model allowlist. A persistent per-agent primary preserves that agent's fallbacks and sibling settings. Existing session overrides remain effective according to OpenClaw's session semantics. The native UI remains the interface for conversations and session-specific choices.

When native reload is off, repeat the preview with `--allow-restart` to permit a controlled Gateway restart. This affects the shared Gateway, including sibling agents. Other reload behavior follows the installed native policy. The command verifies published runtime defaults; merely writing a config file and checking process health does not establish a model change. Acknowledged failures attempt a revision-guarded rollback, and concurrent native edits are preserved.

## Delivery and permissions

The first operation installs checksum-pinned nonsecret worker code and licenses through bounded SSM chunks. Root publishes them under `/var/lib/openclaw-aws/model-artifacts/<digest>`; subsequent operations reuse verified files. Root does not write through Ubuntu state or execute the worker. Ubuntu installs an immutable request, takes the same host flock used by backup/recovery, verifies its IMDSv2 role/EC2 identity, and privately retrieves only the hosting Gateway's SSM token.

No backup vault or additional AWS stack is needed for model-only management. The operator needs the existing stack/EC2/IAM inspection and SSM Run Command permissions. The worker requires the existing scoped Gateway-token read. Current commands require the supported pinned OpenClaw/Node runtime and do not upgrade an older installation implicitly.

## Interrupted or failed changes

Keep `.openclaw-aws/model-operations` and `model-pending` with local operational state. Immutable requests are intent, not proof that a change completed. A pending local operation blocks another model mutation on the same host, including a different agent. Host model journals and maintenance provide the corresponding remote fence. Never delete either hold based on age.

Run `models inspect --operation-id <uuid>` with the original named deployment. It uses the recorded request and original worker pins, rechecks host identity, and distinguishes historical receipt state from a fresh observation. An unavailable Gateway is reported as unavailable. Missing host history is reported as `not-recorded`, with unknown maintenance ownership.

Use `models reconcile --operation-id <uuid> --accept requested|previous --yes` to explicitly accept a verified outcome. Reconciliation does not repeat a model write. Requested-state acceptance requires the requested persisted/published selection. Previous-state acceptance requires the recorded previous selection. If a request never reached model execution, previous-state acceptance additionally requires the original preview revision and persists a terminal no-write receipt, so a delayed SSM execution cannot apply that request later. Unknown or changed state keeps its fence for inspection.

Normal setup configuration retains its creation/provider credential provenance. Live native observations and per-operation outcomes do not silently rewrite those settings. Real AWS/Bedrock inference acceptance is separate from local/native control-plane tests.
