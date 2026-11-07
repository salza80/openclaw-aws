# Native teams on one AWS host

A team owns one EC2 instance and one OpenClaw Gateway. Native agents have separate writable workspaces, model settings, instructions and supported tool policies. The coordinator uses OpenClaw's session messaging/delegation tools; this package does not run another scheduler or model router. All roles share the machine's OS user and instance IAM role.

Create `team.yaml` with nonsecret instructions and optional credential references:

```yaml
schemaVersion: 1
topology: single-host
coordinator: lead
maxConcurrent: 3
maxSpawnDepth: 2
credentials:
  - provider: openrouter-api-key
    kind: env
    reference: OPENROUTER_API_KEY
members:
  - id: lead
    role: Coordinator
    instructions: Assign work, pass actual findings for review, and collect replies.
  - id: researcher
    role: Researcher
    instructions: Research the request and report evidence to the coordinator.
    tools:
      profile: coding
      alsoAllow: [sessions_send]
  - id: reviewer
    role: Reviewer
    instructions: Review the researcher's actual findings and report concrete corrections.
    tools:
      profile: coding
      alsoAllow: [sessions_send]
```

```sh
openclaw-aws team create research --file team.yaml --provider openrouter --region eu-central-1 --yes
openclaw-aws team status research --json
openclaw-aws dashboard --name research
```

Creation uses the shared fresh deployment workflow. The logical coordinator `lead` maps to native agent `main`; other IDs retain their names. Each member receives a separate owned workspace and native agent directory. A team has 2–16 roles; choose EC2 memory for the intended concurrency. The package's 2 GiB minimum is a supported installation floor, not a promise that many concurrent agents fit.

Fresh bootstrap enforces private file-creation modes after switching to the Ubuntu user. This keeps native workspace and agent parent directories compatible with the ownership checks used by team setup. Changed or unsafe existing directories still require inspection; team preview does not repair permissions.

The default coordination policy permits the coordinator to message/delegate to the other declared roles. Members can message the coordinator and cannot spawn other agents. Set `sendTo`/`delegateTo` explicitly to change those grants. Global agent admission, per-agent send permissions, tool availability and session visibility are distinct controls. Handoffs do not lock files shared deliberately outside the private workspaces.

Optional `defaultModel` and per-member `model` accept a fully qualified native reference or `{primary, fallbacks}`. Fresh creation can initialize several API providers using `credentials` entries with `kind: env` or `kind: ssm` and a reference, never a plaintext key. SSM references must resolve to SecureString parameters. Only selected additional provider parameters enter the instance's read grant. Keys are imported through the native stdin credential writer. Credential references in a later configure file are descriptive; configure does not rotate/import API keys. Native auth and model policy must already permit those selections.

Optional Bedrock models use `amazon-bedrock/...`. Team setup reuses the shared provider/IAM operation and previews the plugin capabilities, inference region, exact routes and controlled restart. Permissions belong to the hosting role and retain the union required by the other agents/fallbacks. Metadata checks send no prompts and do not prove paid inference access. OpenRouter remains available.

## Change a team and recover interrupted creation

```sh
# Edit the complete definition, including a new role if required.
openclaw-aws team configure research --file team.yaml --dry-run
openclaw-aws team configure research --file team.yaml --allow-restart --yes

openclaw-aws team create-resume --operation-id <creation-uuid> --yes
openclaw-aws team inspect research --operation-id <setup-uuid>
openclaw-aws team resume research --operation-id <setup-uuid> --yes
openclaw-aws team abort research --operation-id <setup-uuid> --yes
```

Adding members reuses the existing EC2/Gateway. Preview binds the complete existing roster, native revision and instruction file hashes. One native patch publishes the roster and coordination policy. Explicit model settings are then checked in each new owner's policy-filtered native catalog before a separate revision-bound patch. Readiness requires native roster, files, health and published new-session model settings. A model refusal can leave the verified roster configured; inspect/resume or explicitly abort while retaining that roster. Abort does not promise rollback or removal of staged files. Unknown native writes are verified on resume and never repeated.

Fresh-create resume requires the original ready stack's team/create ownership tags and any saved immutable host identity. It never launches a replacement or onboards over an interrupted host. Failed/incomplete CloudFormation provisioning requires inspection and deliberate cleanup. Provider setup interruptions use the existing `providers inspect`/reconciliation commands before team setup continues. Model/provider/team mutations share one local pending fence and host maintenance lock.

Status reads the current native roster and published model selections. The original definition and operation records are historical/desired metadata, not authority to reset subsequent native model changes. Use the native dashboard for conversations and work; all AWS management remains SSM-only.

## Backup, archive and restore the whole team

Create an independent recovery vault using the [backup workflow](native-backup-transport.md), then:

```sh
openclaw-aws team backup research --vault s3://my-vault/recovery --yes
openclaw-aws team archive research --vault s3://my-vault/recovery --dry-run
openclaw-aws team archive research --vault s3://my-vault/recovery --yes

openclaw-aws team archive-inspect --vault s3://my-vault/recovery --region eu-central-1 --operation-id <uuid>
openclaw-aws team archive-resume --vault s3://my-vault/recovery --region eu-central-1 --operation-id <uuid> --yes

# Clean client: source stack and local source config may already be gone.
openclaw-aws backup list --vault s3://my-vault/recovery --region eu-central-1
openclaw-aws team restore research-again --from <backup-uuid> --vault s3://my-vault/recovery --region eu-central-1 --yes
openclaw-aws team restore-resume --operation-id <restore-uuid> --yes
openclaw-aws team activate --operation-id <restore-uuid> --yes
```

There is one complete native backup and one source-stack deletion, regardless of agent count. Team archive refuses undeclared co-hosted agents, incomplete coverage and pending maintenance. The canonical independent backup receipt contains exact native object versions, compatible runtime/settings, credential prerequisites, stable logical-to-native role mapping and a digest of the current native agent/model/tool/delegation/binding configuration. It is published before archive teardown; no always-on team controller or separate backup catalog is required.

Restore verifies the point before provisioning one compatible inactive target. Shared recovery preserves current native settings and workspaces, reconciles target credentials and verifies the team policy digest during staging and immediately before deliberate activation. It recreates the team ownership metadata for later status/archive. The initial team definition is not replayed. Historical sessions, integrations, schedules and hooks remain held/paused according to the [recovery runbook](native-backup-transport.md#reconnection-and-reviewed-work). A new coordination task can be run after deliberate activation; pending work does not restart automatically.

Partial restore resumes only its original target/request. General `restore inspect` and `restore cleanup` remain available for its operation UUID. Independent copies use the existing [clone workflow](independent-clones.md), which preserves supported role policy while creating fresh agent state and requiring explicit target credentials. A saved team receives a new team identity on its independent clone, with the retained logical role mapping and fresh target ownership. Reusing a local name after verified target creation/recovery retains the previous team metadata in local history.

After archive, EC2/root-disk charges end only after verified deletion. Backup storage/versions, retained recovery secrets, shared resources and any KMS keys remain billable. Separate-machine teams and Hermes are outside this feature. Live AWS/model acceptance is deferred to final issue #28; local native fixtures do not establish live inference entitlement or final EC2 recovery acceptance.
