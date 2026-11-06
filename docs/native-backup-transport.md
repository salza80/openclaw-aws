# Native backup integration

The recovery implementation uses the storage and backup APIs of **OpenClaw 2026.11.1**, with Node **24.22.2**. Vault and backup CLI workflows require the separate live AWS acceptance gate as well as offline native conformance tests.

OpenClaw owns archive capture, encryption, storage markers, namespaces, catalog discovery, verification and staged extraction. This project adds AWS provisioning, access policies and receipts identifying exact S3 object versions. A local archive check or a matching stored size is insufficient to commit a completed receipt: verification must download and verify the exact remote archive through the native engine.

## Plugin delivery

`src/openclaw/aws-s3-plugin/` implements the public `openclaw/plugin-sdk/plugin-entry` contract. `npm run build` produces the self-contained `dist/native-plugins/aws-s3/` package, manifest and third-party licenses. Its AWS SDK is bundled; the receiving host supplies the public OpenClaw SDK. No CLI/CDK installation or additional npm dependencies are required for this plugin. The experimental plugin ABI is restricted to the tested native release.

The backend uses the AWS credential chain, including refreshable instance-role credentials. Every request carries the expected bucket owner. Keys stay inside the configured prefix. Writes use conditional creation, exact lengths and checksums; failed multipart uploads are aborted. The bounded 8 MiB part size supports objects up to 78.125 GiB. Vault lifecycle rules also abort abandoned multipart sessions after one day, without expiring completed objects or their older versions.

Host capture explicitly selects `credentialSource: instance-role`, using refreshable IMDSv2 credentials. This prevents AWS credentials saved for model providers from changing backup authority. Clean-client recovery uses the selected operator credential snapshot instead. Code and the nonsecret job travel through exact S3 versions with SHA-256 checks; keys are fetched privately by the host role from the independent Secrets Manager version. Native diagnostics remain in private host job files, outside SSM inline output.

SSM retrieves the nonsecret artifacts into a temporary root-owned directory, because existing bootstrap installations can have an AWS CLI executable private to root. It verifies every checksum before handing the directory to Ubuntu. Ubuntu installs the files atomically and executes the worker; downloaded code is never executed as root. The temporary delivery directory is removed on success or failure, and existing tool/credential permissions are preserved.

The native storage SPI has no S3 VersionId field. The narrow `readVersions` setting supplies an exact-version, read-only view for verification and extraction. Unlisted objects cannot fall back to current state, and listing this view includes committed objects hidden behind later delete markers. This supplements native storage behavior without introducing another archive format or catalog.

## Independent recovery resources

The vault command is available independently of source deployment configuration:

```sh
openclaw-aws vault create primary --region eu-central-1 --profile operator --yes
openclaw-aws vault register s3://my-bucket/recovery --key-arn <independent-secret-arn> --region eu-central-1 --profile operator --yes
openclaw-aws vault inspect s3://my-bucket/recovery --region eu-central-1 --profile operator --json
```

Creation previews the independently retained bucket/key resources. Registration checks an existing bucket without rewriting its policies. Both preserve the original encryption identity on retry. The metadata contains an explicitly labeled Secrets Manager version, so automatic collection of unlabeled secret versions cannot discard that passphrase. Secret values are not included in command arguments, receipts or output.

Existing vaults must have enabled versioning, full public-access blocking, enforced bucket-owner ownership, supported default encryption and a policy denying insecure transport. Lifecycle expiry or storage transitions overlapping the selected prefix are refused. SSE-S3, SSE-KMS and DSSE-KMS defaults are supported; KMS keys must be enabled symmetric keys in the selected account and region. Source permission plans scope KMS use to the S3 encryption context and independent secret. Existing key policies must permit that access; this CLI does not rewrite customer key policies.

`RecoveryVaultStack` retains a private, versioned, TLS-only S3 bucket and an independent Secrets Manager passphrase. Native encryption and S3 server-side encryption both apply. Destroying source compute must not destroy either resource. Retained objects, object versions and the secret continue to incur storage charges.

`RecoveryAccessStack` attaches a prefix-scoped inline policy to a role whose source-stack ownership must first be verified by the application operation. It does not import or resynthesize the source stack. Delete permissions cover probe objects only. The source access stack must be removed before deleting the source role; the independent vault remains.

The policy uses `AWS::IAM::RolePolicy`, with its independent stack name as its discoverable policy name. Cleanup verifies the stack ownership and confirms that its live template contains only the expected role-policy resource before deletion. Source identity inspection also checks the stack-owned EC2 instance/profile/role, unique IAM IDs and absence of another instance sharing the profile. Denied or incomplete inspections do not authorize a write or cleanup.

The operator needs CloudFormation describe/resource inventory/create access, source EC2/IAM read access, and permission to create the scoped inline role policy. Destroy additionally needs IAM role/inline-policy reads and CloudFormation template/tag reads plus deletion of the owned recovery-access stack. Backup reads require S3 list/get/version access within the vault and access to the retained Secrets Manager version (and applicable KMS decrypt permissions). S3/Secrets Manager access must remain available to the recovery operator after the source role is deleted.

`src/aws/recovery-store.ts` writes thin immutable AWS metadata with conditional creation and exact-version byte readback. Identical retries can adopt an existing receipt; collisions, missing versions, malformed data and denied access fail. These primitives alone do not establish that a native recovery point is complete. Application code must validate native verification and coverage requirements before writing a completed receipt.

## Capture and discovery

`backup create --name <deployment> --vault <s3-uri> --yes` uses the existing deployment target and an already registered vault. The optional `--label` is nonsecret metadata. The command prints its operation UUID before mutation; `--operation-id <uuid>` resumes that operation. Source version and ownership checks precede access provisioning. Recovery storage, secret and KMS resources owned by the source stack are refused.

The host locks the complete installation, remembers whether its Gateway was active, and stops an active service. Public native config APIs add the managed storage transport while preserving models, agents and unrelated storage settings. Native backup captures all declared members and workspaces. Credential inventory checks the source config, native auth profiles and provider files; exec references, missing environment secrets, uncaptured files, unresolved references and external archive symlinks refuse full certification. Default config folded inside state is checked using its actual canonical path. Native SQLite snapshots remain authoritative; `.env` and native secret-store state are inside the encrypted archive.

The archive and marker are pinned by actual S3 VersionId. The worker downloads, decrypts and fully verifies those versions through the native engine before publishing nonsecret capture metadata. It then restores prior service state; failed health restoration retains the maintenance record and is reported separately from backup validity. Only validated complete capture metadata can produce an AWS receipt. Uncertain SSM outcomes never authorize completion; a retry can adopt an already verified capture without stopping the service again. No retention flags, scheduling or automatic pruning are applied.

`backup list`, `backup inspect <uuid>` and `backup verify <uuid>` require `--vault`, `--region` and optional `--profile`; they do not read local deployment configuration or source SSM keys. Listing confirms completed points against the native backup catalog using exact versions. Inspect reports filtered AWS/native metadata and prerequisites. Verify downloads and fully verifies the archive again from the clean helper, even when current S3 objects have later delete markers. Destroying a source removes only its verified recovery-access stack; the vault and key are independently retained.

This release handles backup creation/discovery/verification. Provisioning a restored installation, archive-and-destroy and independent cloning are subsequent feature issues; a standalone backup is not permission to delete the source automatically.

## Clean-client helper

`src/openclaw/backup-helper.ts` provisions a private, lockfile-pinned OpenClaw helper from `templates/openclaw/native-helper/`. Linux/macOS x64 and arm64 clients receive a private Node 24.22.2 runtime, verified against published Node release checksums. They do not depend on a global OpenClaw or an old deployment's configuration. Other platforms require the pinned Node runtime and npm to be supplied explicitly and have not received the same acceptance test.

The helper receives a private temporary native configuration, the independently retained passphrase through a native file SecretRef, and a sufficiently long-lived snapshot of the selected operator's AWS credentials. Its temporary key file has mode 0600; the key does not enter command arguments or the child environment. This preserves multiline and NUL-containing passphrases. It runs typed read/list/verify/staged-restore operations, forces read-only S3 access, and removes temporary state afterwards. It sends no model prompts and starts no Gateway. Child errors must not expose environment variables or raw native output. An installer lock is never stolen based on its age.

The pinned host and helper use compatible zod 4.6.6 and npm 12.2.2 security patches. The dependency audit still reports moderate minimatch advisories; resolving them requires assessing a major dependency change. Do not use forced audit fixes that downgrade OpenClaw.

## Verification

The normal suite covers conditional-write/multipart failure cases, prefix boundaries, immutable receipt readback, infrastructure retention and private helper provisioning. Its real native conformance test runs against loopback-only S3 and IMDS fixtures with fake credentials. It proves role refresh within one backend, plugin discovery, native storage init/test, encrypted offsite capture, native listing, full remote verification and staged extraction of two workspaces plus a custom agent root.

For a fresh-helper acceptance run, set `OPENCLAW_AWS_TEST_NATIVE_HELPER` to the installed helper directory and run `test/integration/native-s3.test.ts` with Vitest. This exercises the same conformance suite against its separately installed host and plugin. Local fixtures make no AWS calls. They do not replace the separately approved live AWS gate for IAM isolation, versioning, multipart behavior and disaster recovery.
