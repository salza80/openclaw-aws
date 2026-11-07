# Local AWS console

Run `openclaw-aws ui` from the directory containing your `.openclaw-aws` configurations. The command opens a browser and serves the bundled React application on an automatically selected `127.0.0.1` port. It needs no public website, separate frontend installation, cloud database or running OpenClaw host. `--port 19445` chooses a port. `--no-open` explicitly prints a private, one-use pairing link; keep that link private and use it within ten minutes.

The console lists each saved deployment using that configuration's AWS profile and region. Refresh observations after changing power or completing an operation. Gateway health, runtime version and team membership carry observation timestamps; saved membership and historical runtime readings are labelled separately. Unknown or unreachable agents are never presented as idle. Team members share one hosting EC2 instance and Gateway.

## Review and apply

Choose an operation, enter its structured inputs and select **Prepare review**. Review the concrete AWS account, region, original host identity, recovery point, effects and retained costs, then select **Apply reviewed operation**. A prepared review alone does not authorize execution. IAM previews can create review metadata; discarding the preview cleans up its owned unapplied change set.

Create uses the pinned fresh installer, a default VPC, encrypted 30 GiB root disk and a supported instance type (`t3a.small` by default). If required, the review includes account/region CDK bootstrap creation or upgrade. Bedrock setup reviews the native model/embedding plugin and concrete invocation resources. AWS bills Bedrock inference; existing OpenRouter and other API credentials remain separate.

Credential inputs are existing environment-variable names or SSM SecureString references, optionally with an exact version. Never enter API key values. Extra provider references can be supplied for a mixed-provider team or independent copy. Values are resolved privately on the backend after approval and never returned to the lifecycle application.

Creating a team first provisions its shared host and declared provider inventory. The result offers a separate native-team configuration review on that concrete host. Additional Bedrock models require the shared **Enable Bedrock** workflow before selecting them for roles. Team definitions use the same JSON schema, instructions, tool policy and explicit send/delegate controls as the [team CLI](teams.md). Existing teams retain their stable identity when configured again.

## Recovery without the source

Enter the independent `s3://bucket/prefix`, its AWS region and profile under **Saved work**, then discover recovery points. This works after the source host and local configuration are removed. Saved agents, role mapping and timestamps come from canonical verified backup metadata. An **archived** label requires a completed independent teardown receipt; a held backup alone is not evidence that compute was deleted.

**Restore identity** requires the original source to be gone. **Copy as new claw** creates an independent identity using explicit target credentials, with selected knowledge and native policy. Both operations review a new target host/disk and leave its Gateway inactive. Their results offer a separate recovery/activation review. Native checks, paused external integrations and historical-session holds remain authoritative.

**Archive host** covers the complete native roster: verify a full backup, retain independent recovery metadata, then delete the original hosting resources and owned source credentials. Disk/vault versions, encryption keys, shared CDK bootstrap and other retained resources can still cost money. Ordinary **Stop** only stops compute; it retains the hosting disk.

## Progress, interruptions and native UI

The local backend persists private invocation records under `.openclaw-aws/ui/jobs`. Repeated apply requests use the same invocation; closing or reloading a browser does not cancel or repeat it. A backend restart treats interrupted work as uncertain and never automatically replays a write. Prepare recovery using the original operation ID and its native archive/restore/clone/team/model/provider journal. A preview from a previous backend session must be prepared again before execution.

On a failed operation, inspect the original stack, retained resources and operation before creating a replacement. In particular, failed fresh provisioning must not be repeated blindly under a new name. Host-operation locks are never cleared based on age; follow the existing verified lock-recovery instructions if the process crashed. Ctrl+C stops accepting HTTP work and waits for applied operations before closing owned tunnels.

**Open OpenClaw** opens the existing native UI through an owned SSM tunnel on a separate available local port. The backend performs the explicit native authentication handoff. Conversations, detailed activity, tools and automations stay in OpenClaw; this console provides AWS lifecycle operations rather than another agent scheduler or chat store.

The lifecycle API uses a short-lived one-use pairing code followed by an HttpOnly, SameSite cookie, exact Host/Origin checks and authenticated JSON mutations. Browser storage does not persist credentials or tokens. Live AWS and paid-model acceptance is tracked separately in issue #28; local tests and fixtures do not claim that validation has run.
