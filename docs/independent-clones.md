# Independent knowledge clones

Restore recovers the saved installation and holds its historical conversations. Clone creates a fresh installation with selected inherited knowledge. It shares restore's pinned inactive bootstrap, exact-version native archive verification, AWS delivery, operation ownership and cleanup boundaries.

## Preview and create

Choose a completed backup UUID and independent vault, including its region and operator profile. The source can be running or already destroyed; clone neither changes nor requires its infrastructure. The target must have an unused deployment name in the same AWS account/partition. A different target region/profile is supported with `--target-region` and `--target-profile`.

```sh
openclaw-aws clone preview --from <backup-uuid> \
  --vault s3://my-vault/recovery --region eu-central-1 --profile operator \
  --name research-copy --json
```

Preview verifies and extracts exact native object/key versions using the managed pinned helper, selects compatible policy and files, and deletes decrypted local staging before returning. It creates no target infrastructure. The report includes agent roles, selected/omitted relative paths and hashes, supported policy, required providers and target sizing. It contains no credential values or physical staging paths.

Review workspace instructions and skill code before cloning: retained project files can contain operator-authored external service references or sensitive text. The selector excludes recognized credential files and referenced file secrets, but it is not a general secret scanner or code sandbox.

```sh
openclaw-aws clone --from <backup-uuid> \
  --vault s3://my-vault/recovery --region eu-central-1 --profile operator \
  --name research-copy --provider openrouter --key-env COPY_OPENROUTER_KEY --yes
```

Creation repeats preview and displays its concrete EC2/disk/account/region plan. It binds selected content/policy digests to the host request and checks them again before fresh initialization. One new host/Gateway contains the complete supported roster; this command does not export one agent into an existing team. `--instance-type` and `--volume-gib` can increase capacity. Sizing reserves extracted source data, the archive and the selected second copy. Compute and disk remain billable while staged.

## Explicit model credentials

`--provider` chooses the primary setup credential, defaulting to OpenRouter; it does not replace saved models. Every selected primary/fallback route needs compatible credentials. Use the short provider names accepted by create or their full `*-api-key` configuration names.

- `--key-env VARIABLE`: read only this named environment variable for the primary provider.
- `--reuse-ssm /absolute/parameter`: deliberately reuse this primary model credential from the vault region/operator profile. Optional `:version` pins a parameter version.
- Repeat `--credential-env openai=OTHER_VARIABLE` or `--credential-ssm openai=/path` for additional providers.
- Without `--yes`, interactive use collects missing credentials through private password entry. Noninteractive use requires `--yes` and explicit references for every required provider.

Do not pass literal keys as argument values. Ambient provider environment variables and the archive's `.env` or auth databases are never implicit credential candidates. SSM reuse must resolve a SecureString. The operator imports values create-only into the new target's provider namespace with exact stack/operation tags; a retry adopts only an identical value with the same ownership. Records, request objects, argv and public diagnostics carry provider names/references, never key values.

If a saved route uses Cloudflare AI Gateway, select `--provider cloudflare-ai-gateway` and explicit target `--cloudflare-account-id` / `--cloudflare-gateway-id`; supply any OpenRouter/direct-provider credentials separately. Custom provider endpoints and unsupported native runtimes need supported explicit setup rather than automatic source configuration adoption. Bedrock setup is delivered separately under #14.

## Copied and reset

The default scope is the whole saved team on one new host:

| Preserved                                                                                         | Reset or omitted                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Valid native role IDs, system owner, supported internal delegation and agent-to-agent permissions | New native databases, session/auth ownership and per-role stores                                                   |
| Persona/instructions, MEMORY.md and file-backed workspace memory                                  | Sessions/history, pending work, approvals and delivery state                                                       |
| Workspace skills, state skills and per-agent workshop files; owner execution permissions          | Source OAuth/device/channel tokens, `.env`, known credential files, machine settings and links                     |
| Compatible models, fallbacks, aliases, restrictions, embedded runtime selection and tool policy   | Custom provider endpoints, opaque plugins/personal skill-library ownership and external MCP/database configuration |

Overlapping/shared workspaces or unsupported ownership mappings are refused. Opaque native databases are never edited or adopted as fresh identity. Source Git metadata, runtime dependencies/caches, database files and filesystem links are excluded and reported. Reinstall reviewed dependencies and use supported native exports for opaque skill libraries where available.

Cron, heartbeat, hooks, bootstrap execution and semantic indexing remain disabled; messaging channels and configured MCP servers are absent. Model credentials can be deliberately reused, while Gateway authentication, deployment parameters and future backup ownership are new. A backup taken from the clone uses its own deployment namespace. The parent recovery point is lineage only.

## Stage, activate and recover

Successful staging reports copied file counts, omitted paths/policy, roster and an operation UUID. It leaves the Gateway masked/inactive. The host deletes the entire decrypted source extraction before certifying readiness so source auth/history cannot remain readable to an active clone.

```sh
openclaw-aws clone activate --operation-id <clone-uuid> --yes
openclaw-aws clone inspect --operation-id <clone-uuid> --json
openclaw-aws clone resume --operation-id <clone-uuid> --yes
```

Activation removes temporary recovery-access policies, checks installed code/request checksums, validates certified native configuration and the new Gateway token, and proves source key/archive reads are denied through the instance role. Permission propagation can delay activation. Missing-object or network errors are not proof of revocation. Native service installation/start is followed by authenticated health and another safety validation; failure remasks the service or reports uncertainty. No paid model probe is sent.

`--activate` on the initial clone command requests both stages with the same checks. After activation, use `openclaw-aws dashboard --name research-copy` to configure fresh channel pairing and review external connections, schedules and skill dependencies through native controls before enabling them.

Resume pins account/partition, immutable stack/instance/role, original preview and exact request/artifact versions. It does not recreate an absent deployment or rerun onboarding over partial native identity. A lost successful activation reply can be adopted only after live validation/health. An unfinished credential import can be retried with the same explicit references on `clone resume`; provider selection cannot change. Once staging is certified, change credentials through provider management rather than recovery replay.

Private journals live in `.openclaw-aws/clones/<uuid>.json`. Inspection reports historical metadata, not current health. Retain that directory until an operation is resolved. If native setup was interrupted after it began, inspect or clean up the owned target and start a new clone instead of deleting ownership holds or forcing onboarding over it.

```sh
openclaw-aws clone cleanup --operation-id <clone-uuid> --yes
```

Cleanup verifies immutable stack identity and operation tags, removes source-access policies, deletes the clone stack and operation-owned parameters, and removes matching local deployment metadata. Explicit cleanup loses any active clone data. Source infrastructure, independent vault/key and parent backup remain. Cleanup also handles owned failed stacks before a local deployment config was written. Interrupted creation may leave billable resources.

## AWS permissions and validation

Alongside existing recovery/provisioning permissions, the operator needs SSM PutParameter with tags for the new target namespace and GetParameter/ListTagsForResource for identical retry adoption; explicit SSM reuse needs decrypted read access to the selected source parameter. Delivery writes nonsecret code and request metadata under `_tools` and `_operations/clone` within the source's native vault prefix; existing archive/marker versions are never rewritten. The host receives temporary prefix-scoped source archive/key reads and target provider tag inspection. Its base role reads its own provider parameters. Clone does not grant the host provider-secret writes. Independent vault/KMS/bucket policies still apply.

Local tests cover native multi-agent identity creation, mixed-provider auth/status without inference, retained content/skill execution, secret/session exclusions, immutable delivery, retry ownership, permission revocation and activation rollback. A full disposable EC2 clone/health/coexistence drill has not been run. Deferred fresh-host restore acceptance remains a prerequisite for automatic archive teardown under #11.
