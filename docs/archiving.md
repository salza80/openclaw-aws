# Archive a deployment

Archive saves one complete native installation backup, verifies the exact remote point through the independent vault, and removes the deployment's owned AWS resources. It covers every native agent on that host. A separate full backup or EC2 instance is not created for each agent.

```sh
openclaw-aws archive --name personal --vault s3://my-vault/recovery
```

The preview lists the account/region, immutable stack and instance, root disk, complete agent roster, resource and credential names to delete, and retained recovery storage. Noninteractive use requires `--yes`. The vault must already be registered and independent of the source. OpenRouter, direct providers and optional Bedrock retain their native saved settings; archive does not send a model prompt or convert providers.

The command accepts the supported running EC2 deployment, its single encrypted auto-deleted root disk, supported unretained deployment resources and a complete native roster. Start a stopped EC2 instance before archiving. Unsupported state, extra disks, retained resources, changed ownership, unavailable recovery material or incomplete verification prevents automatic teardown.

## Work, backup and teardown

An active Gateway must acknowledge native cooperative suspension with no active work or pending write custody. Busy work is not forcefully terminated. Archive preserves the original service definition and installs a persistent inactive hold covering capture, verification and teardown, including reboot. An ordinary `backup create` still restores the prior service state.

The final native capture must include every approved member/root. Its exact S3 versions and decryption-key references remain independent of the source. The operator's clean-client helper verifies the point before the host acknowledges its teardown commitment. The client commits that acknowledgement in the independent vault before deleting the original stack ARN.

Source recovery/Bedrock policy stacks are removed before the host role. Archive verifies stack deletion, instance termination and root-disk removal before deleting unchanged source credentials, with the Gateway namespace reservation last. Local source configuration is removed by default only when its saved identity/settings still match. Use `--keep-config` to retain it. Changed local configuration is retained and reported.

The final report includes the recovery-point ID, vault URI and copyable restore/clone commands. The independent vault, retained backup versions, recovery key, shared/default VPC and shared CDK bootstrap survive. Backups, keys and shared resources can still incur charges; archive does not promise zero total AWS cost.

## Interrupted operations

Keep the printed operation UUID and vault URI. Independent lifecycle records live alongside the native backup, outside the source stack. Local records are a convenience; recovery commands also work from a clean client:

```sh
openclaw-aws archive inspect --operation-id <uuid> --vault s3://my-vault/recovery --region eu-central-1 --json
openclaw-aws archive resume --operation-id <uuid> --vault s3://my-vault/recovery --region eu-central-1 --yes
openclaw-aws archive abort --operation-id <uuid> --vault s3://my-vault/recovery --region eu-central-1 --yes
```

Add `--profile` to select recovery credentials in the original account. Resume uses the original job, request/object versions and code checksums. It adopts durably verified capture metadata without another native capture. An interrupted capture with an unknown result requires inspection/owned abort; it is not blindly repeated. If source delivery has not been pinned yet, inspect the original client rather than assuming that a delayed operation is canceled.

Before teardown commitment, owned abort restores the original service definition/state and releases this operation's maintenance. Backup/verification failure restores the source when restoration can be confirmed. Unknown outcomes retain their evidence and ownership. After commitment, abort cannot restart the source: resume finishes cleanup, or restore a new deployment from the saved point. Partial CloudFormation deletion retains the backup, source credentials and local configuration until cleanup prerequisites pass. Never remove maintenance merely because it is old.

Inspection separates recorded progress from fresh host observation; unreachable is not healthy or idle. A completed archive requires no always-on controller. Use `restore --from <uuid>` to bring it back, or `clone --from <uuid>` for an independent copy. Restore stages an inactive target and requires deliberate activation, retaining historical session holds and paused integrations.

## Validation scope

Local/native conformance, failure/retry tests, packaging, review and CI are the implementation gates. Cost-incurring AWS acceptance is deferred to [the final integrated validation campaign](https://github.com/salza80/openclaw-aws/issues/28), together with the other merged features. Local fixtures and metadata discovery do not prove that final live drill passed.
