# Repository guidance

This is an AWS-only CLI for OpenClaw deployments. Keep TypeScript on major version 6. Preserve v1 configuration, deployment names and existing SSM parameter paths. Do not add runtime registries, Hermes adapters or another model router.

- CLI commands collect inputs, display plans and handle errors. Share provisioning through `src/operations/deployment.ts`; commands must not call other command handlers. `init` and `create` share the configuration workflow.
- `src/aws/target.ts` resolves credentials per target without modifying `process.env`. Pass that target to AWS clients. CDK child processes must use a captured configuration snapshot instead of rereading editable files, plus a private working/home directory so concurrent assemblies and unrelated CDK settings cannot interfere. Resolve a fresh, sufficiently long-lived child environment for each CDK attempt. Never persist or log credentials, provider keys, tokens or raw native auth results.
- Use `src/aws/ssm.ts` for bounded remote execution and `src/openclaw/commands.ts` for the Ubuntu/private-prefix/legacy-NVM environment and native structured results. Check status, exit code and truncation before interpreting output. Native reads must not send model prompts unless explicitly requested.
- Serialize shared Gateway mutations per hosting deployment using the operations lock. Native agent IDs do not own EC2 instances or separate deployment locks.
- Local deployment metadata separates stable CloudFormation identity, desired settings and native observations. Observing drift does not authorize applying configuration changes. Preserve metadata on inspection failures; verify identity before destruction or secret cleanup.
- Reuse native OpenClaw backup, storage, agent and model semantics. AWS transports and provisioning receipts belong here; native archive formats and inference routing do not.
- New installations use the packaged bootstrap template and pinned installer inputs. Existing deployments are not implicitly upgraded or replaced. A failed AWS read is not permission to provision, destroy or clean up secrets.

Run build, typecheck, lint, formatting and the full Vitest suite for feature PRs. Local tunnel integration tests bind loopback ports and launch disposable local processes; they make no AWS calls. Live AWS acceptance is separate and needs a concrete approved account/region/resource/budget/cleanup scope. Keep transient execution tracking in the requested local Markdown plan, outside feature commits.
