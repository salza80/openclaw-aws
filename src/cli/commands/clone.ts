import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { prepareClone, stageClone, resumeClone, cleanupClone } from '../../operations/clone.js';
import { loadCloneRecord, cloneReport, type CloneRecord } from '../../operations/clone-record.js';
import { resolveAwsTarget, type AwsTarget } from '../../aws/target.js';
import { parseVaultUri } from '../../aws/recovery-store.js';
import { backupOperationId } from '../../operations/backup.js';
import { OPENCLAW_PROVIDER_SETUP } from '../../openclaw/install.js';
import type { ExplicitCloneCredentials } from '../../openclaw/clone-credentials.js';
import { explicitCloneCredentials } from '../../openclaw/clone-credentials.js';
import type { Provider } from '../types/index.js';
import { providerChoice } from '../utils/providers.js';
import { createSsmClient } from '../utils/aws-clients.js';
import { handleError, ValidationError } from '../utils/errors.js';

interface CloneArgs {
  action?: string;
  from?: string;
  vault?: string;
  region?: string;
  profile?: string;
  targetRegion?: string;
  targetProfile?: string;
  name?: string;
  provider?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  instanceType?: string;
  volumeGib?: number;
  operationId?: string;
  keyEnv?: string;
  reuseSsm?: string;
  credentialEnv?: string[];
  credentialSsm?: string[];
  activate?: boolean;
  yes?: boolean;
  json?: boolean;
}
type CredentialSource = { provider: Provider; kind: 'env' | 'ssm'; reference: string };
export function cloneCredentialSources(argv: CloneArgs, primary: Provider): CredentialSource[] {
  const sources: CredentialSource[] = [];
  const add = (provider: Provider, kind: 'env' | 'ssm', reference: string) => {
    if (sources.some((source) => source.provider === provider))
      throw new ValidationError('Select exactly one explicit credential source per provider');
    if (
      kind === 'env'
        ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)
        : !/^\/[A-Za-z0-9_./-]+(?::[1-9][0-9]*)?$/.test(reference)
    )
      throw new ValidationError(
        'Credential references must name an environment variable or an absolute SSM parameter path',
      );
    sources.push({ provider, kind, reference });
  };
  if (argv.keyEnv) add(primary, 'env', argv.keyEnv);
  if (argv.reuseSsm) add(primary, 'ssm', argv.reuseSsm);
  for (const [kind, entries] of [
    ['env', argv.credentialEnv],
    ['ssm', argv.credentialSsm],
  ] as const)
    for (const entry of entries ?? []) {
      const split = entry.indexOf('=');
      if (split < 1) throw new ValidationError('Use provider=REFERENCE for additional credentials');
      add(providerChoice(entry.slice(0, split)), kind, entry.slice(split + 1));
    }
  return sources;
}
async function credentials(
  primary: Provider,
  sources: CredentialSource[],
  required: string[],
  target: AwsTarget,
  interactive: boolean,
): Promise<ExplicitCloneCredentials> {
  const values: ExplicitCloneCredentials = {};
  for (const source of sources) {
    if (source.kind === 'env') {
      const value = process.env[source.reference];
      if (!value)
        throw new ValidationError(`Explicit credential variable ${source.reference} is empty`);
      values[source.provider] = value;
    } else {
      const client = createSsmClient(target);
      let value: string | undefined;
      try {
        const result = await client.send(
          new GetParameterCommand({ Name: source.reference, WithDecryption: true }),
          { abortSignal: AbortSignal.timeout(30000) },
        );
        if (
          result.Parameter?.Name === source.reference.split(':')[0] &&
          result.Parameter.Type === 'SecureString'
        )
          value = result.Parameter.Value;
      } catch {
        /* Do not expose SDK authentication/decryption details. */
      } finally {
        client.destroy();
      }
      if (!value)
        throw new ValidationError(
          `The explicitly selected ${source.provider} SSM credential could not be resolved`,
        );
      values[source.provider] = value;
    }
  }
  const needed = new Set<Provider>([primary]);
  for (const nativeId of required) {
    const provider = (Object.keys(OPENCLAW_PROVIDER_SETUP) as Provider[]).find(
      (provider) =>
        OPENCLAW_PROVIDER_SETUP[provider].providerId === nativeId ||
        OPENCLAW_PROVIDER_SETUP[provider].providerAliases?.includes(nativeId),
    );
    if (!provider)
      throw new ValidationError(
        `This clone needs unsupported provider setup for '${nativeId}'; no target was provisioned`,
      );
    needed.add(provider);
  }
  for (const provider of needed)
    if (!values[provider]) {
      if (!interactive)
        throw new ValidationError(
          `Supply an explicit --credential-env ${provider}=VARIABLE or --credential-ssm ${provider}=/path. Archived credentials are never used`,
        );
      const result = await prompts({
        type: 'password',
        name: 'value',
        message: `Fresh ${provider} credential for this clone:`,
      });
      if (!result.value) throw new ValidationError('Clone credential entry cancelled');
      values[provider] = result.value;
    }
  explicitCloneCredentials(primary, values);
  return values;
}
async function approve(argv: CloneArgs, details: string) {
  console.error(details);
  if (argv.yes) return true;
  if (!process.stdin.isTTY)
    throw new ValidationError(
      'Noninteractive cloning requires --yes to approve the displayed AWS plan',
    );
  const result = await prompts({
    type: 'confirm',
    name: 'approved',
    message: 'Continue this clone operation?',
    initial: false,
  });
  return result.approved === true;
}
function publicRecord(record: CloneRecord) {
  return {
    operationId: record.operationId,
    name: record.name,
    recordedPhase: record.phase,
    backup: { id: record.recovery.pointId, vault: record.recovery.uri },
    region: record.config.aws.region,
    target: record.target,
    scope: 'whole-team-knowledge',
    report: record.report,
    permissionCleanupPending: record.permissionCleanupPending ?? false,
  };
}
function show(record: CloneRecord, json: boolean, inspection = false) {
  if (json) {
    console.log(JSON.stringify(publicRecord(record), null, 2));
    return;
  }
  console.log(
    `Clone ${record.operationId}: ${inspection ? 'recorded ' : ''}${record.phase}\nDeployment: ${record.name}\nRegion: ${record.config.aws.region}\nAgents: ${record.report.agentIds.join(', ')}\nCopied files: ${record.report.copiedFiles}; omitted paths: ${record.report.omittedEntries}${record.target ? `\nInstance: ${record.target.instanceId}` : ''}`,
  );
  for (const omission of record.report.omissions) console.log(omission);
  if (record.phase === 'ready-inactive')
    console.log(
      `Activate after review: openclaw-aws clone activate --operation-id ${record.operationId}`,
    );
  if (record.phase === 'active' && !inspection)
    console.log(
      'Gateway health verified. Review native channel pairing, external connections and schedules before enabling them.',
    );
  if (record.permissionCleanupPending)
    console.log('Recovery permission cleanup is pending; resume this operation before activation.');
}
export async function runCloneCommand(argv: CloneArgs) {
  const action = argv.action ?? 'stage';
  if (!['stage', 'preview', 'resume', 'activate', 'inspect', 'cleanup'].includes(action))
    throw new ValidationError('Use clone stage, preview, resume, activate, inspect or cleanup');
  if (action === 'stage' || action === 'preview') {
    if (action === 'preview' && argv.activate)
      throw new ValidationError('Preview does not activate a target; omit --activate');
    if (!argv.from || !argv.vault || !argv.region || !argv.name)
      throw new ValidationError(
        'Clone requires --from <backup-id>, --vault <s3-uri>, --region <vault-region> and --name <unused-name>',
      );
    backupOperationId(argv.from);
    parseVaultUri(argv.vault);
    const primary = providerChoice(argv.provider ?? 'openrouter');
    const sources = cloneCredentialSources(argv, primary);
    const recoveryTarget = await resolveAwsTarget({ region: argv.region, profile: argv.profile });
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    let plan: Awaited<ReturnType<typeof prepareClone>>;
    try {
      plan = await prepareClone({
        recoveryTarget,
        vaultUri: argv.vault,
        pointId: argv.from,
        name: argv.name,
        apiProvider: primary,
        cloudflareAccountId: argv.cloudflareAccountId,
        cloudflareGatewayId: argv.cloudflareGatewayId,
        region: argv.targetRegion,
        profile: argv.targetProfile ?? argv.profile,
        instanceType: argv.instanceType,
        volumeGiB: argv.volumeGib,
        operationId: argv.operationId,
        signal: cancellation.signal,
      });
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    const summary = {
      operationId: plan.operationId,
      name: plan.context.name,
      account: plan.context.target.account,
      region: plan.context.target.region,
      instanceType: plan.context.config.instance.type,
      volumeGiB: plan.bootstrap.volumeGiB,
      preview: plan.preview,
    };
    if (action === 'preview') {
      if (argv.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(
          `Whole-team knowledge preview: ${plan.preview.content.members.map((member) => member.id).join(', ')}\nProviders in use: ${plan.preview.providersInUse.join(', ')}\nNew target: ${plan.context.name}, ${plan.context.config.instance.type}, ${plan.bootstrap.volumeGiB} GiB in ${plan.context.target.region}`,
        );
        for (const omission of plan.preview.policy.omissions) console.log(omission);
        console.log(
          'No AWS target resources were created. Use --json for selected and omitted file details.',
        );
      }
      return;
    }
    const totals = cloneReport(plan.preview);
    const report =
      `${totals.copiedFiles} selected files and ${totals.omittedEntries} omitted paths across workspace, shared and private agent skill scopes.\n` +
      plan.preview.content.members
        .map(
          (member) =>
            `${member.id}: ${member.files.length} workspace files, ${member.omitted.length} omitted paths`,
        )
        .join('\n');
    if (
      !(await approve(
        argv,
        `Clone whole-team knowledge from ${argv.from} as '${plan.context.name}' in AWS ${plan.context.target.account}/${plan.context.target.region}. Create one ${plan.context.config.instance.type} EC2/Gateway host, a ${plan.bootstrap.volumeGiB} GiB encrypted disk and its IAM/network resources. Preserve source role IDs/model choices with fresh native identities and explicitly selected credentials; the source may remain live. ${argv.activate ? 'Activate after validation with automatic integrations disconnected.' : 'Leave the Gateway masked for separate activation.'} Operation: ${plan.operationId}. Compute/storage remain billable until cleanup.\n${report}\n${plan.preview.policy.omissions.join('\n')}\nExplicit credential references: ${sources.map((source) => `${source.provider} via ${source.kind} ${source.reference}`).join(', ') || 'interactive entry required'}`,
      ))
    )
      return;
    const values = await credentials(
      primary,
      sources,
      plan.preview.providersInUse,
      recoveryTarget,
      !argv.yes && Boolean(process.stdin.isTTY),
    );
    let record = await stageClone(plan, recoveryTarget, values, {
      progress: (message) => console.error(message),
    });
    if (argv.activate)
      record = await resumeClone(record.operationId, {
        activate: true,
        progress: (message) => console.error(message),
      });
    show(record, Boolean(argv.json));
    return;
  }
  if (!argv.operationId)
    throw new ValidationError('Select an existing clone with --operation-id <uuid>');
  if (
    argv.from ||
    argv.vault ||
    argv.region ||
    argv.profile ||
    argv.targetRegion ||
    argv.targetProfile ||
    argv.name ||
    argv.provider ||
    argv.cloudflareAccountId ||
    argv.cloudflareGatewayId ||
    argv.instanceType ||
    argv.volumeGib !== undefined ||
    argv.activate
  )
    throw new ValidationError(
      'Existing clone operations use their pinned target and credentials; select --operation-id only',
    );
  let record = loadCloneRecord(argv.operationId);
  const hasCredentialReferences = Boolean(
    argv.keyEnv || argv.reuseSsm || argv.credentialEnv?.length || argv.credentialSsm?.length,
  );
  if (hasCredentialReferences && action !== 'resume')
    throw new ValidationError(
      'Only clone resume accepts explicit credential references for an unfinished import',
    );
  if (action === 'inspect') {
    show(record, Boolean(argv.json), true);
    return;
  }
  if (action === 'cleanup') {
    if (
      !(await approve(
        argv,
        `Delete clone stack '${record.config.stack.name}' and its operation-owned target credentials in ${record.config.aws.region}. All clone instance data will be lost. The source, independent vault and original backup remain.`,
      ))
    )
      return;
    await cleanupClone(record.operationId);
    console.log(
      argv.json
        ? JSON.stringify({
            operationId: record.operationId,
            phase: 'deleted',
            sourceAndBackupRetained: true,
          })
        : 'Clone target and owned credentials removed. Source and recovery point retained.',
    );
    return;
  }
  if (
    !(await approve(
      argv,
      `${action === 'activate' ? 'Activate the validated clone with integrations disconnected' : 'Resume the existing clone without recreating an absent target'}: ${record.name}, ${record.config.aws.region}, operation ${record.operationId}. Source-backup/key permissions are removed before activation.`,
    ))
  )
    return;
  let resumedCredentials: ExplicitCloneCredentials | undefined;
  if (hasCredentialReferences) {
    if (record.result)
      throw new ValidationError(
        'Clone staging is already certified; credentials cannot be changed through resume',
      );
    const sources = cloneCredentialSources(argv, record.credentials.primary);
    const credentialTarget = await resolveAwsTarget({
      region: record.recovery.region,
      profile: record.recovery.profile,
    });
    if (
      credentialTarget.account !== record.account ||
      credentialTarget.arn.split(':')[1] !== record.partition
    )
      throw new ValidationError(
        'Credential reference profile differs from the pinned clone account',
      );
    resumedCredentials = await credentials(
      record.credentials.primary,
      sources,
      record.credentials.providers.map((provider) => OPENCLAW_PROVIDER_SETUP[provider].providerId),
      credentialTarget,
      !argv.yes && Boolean(process.stdin.isTTY),
    );
  }
  record = await resumeClone(record.operationId, {
    activate: action === 'activate',
    credentials: resumedCredentials,
    progress: (message) => console.error(message),
  });
  show(record, Boolean(argv.json));
}
export const cloneCommand: CommandModule<{}, CloneArgs> = {
  command: 'clone [action]',
  describe: 'Copy a saved team’s knowledge into an independent AWS claw',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['stage', 'preview', 'resume', 'activate', 'inspect', 'cleanup'] as const,
        default: 'stage',
      })
      .option('from', { type: 'string', describe: 'Explicit completed recovery point UUID' })
      .option('vault', { type: 'string', describe: 'Independent s3://bucket/vault-prefix' })
      .option('region', { type: 'string', describe: 'Vault region' })
      .option('profile', { type: 'string', describe: 'Vault operator AWS profile' })
      .option('target-region', { type: 'string', describe: 'Region for the new target' })
      .option('target-profile', {
        type: 'string',
        describe: 'Target AWS profile in the same account',
      })
      .option('name', {
        type: 'string',
        describe: 'Unused deployment name; entire team shares one new host',
      })
      .option('provider', {
        type: 'string',
        describe:
          'Primary credential provider (default openrouter); saved model choices are preserved',
      })
      .option('cloudflare-account-id', { type: 'string' })
      .option('cloudflare-gateway-id', { type: 'string' })
      .option('instance-type', { type: 'string' })
      .option('volume-gib', { type: 'number' })
      .option('operation-id', {
        type: 'string',
        describe: 'Existing clone operation or explicit new UUID',
      })
      .option('key-env', {
        type: 'string',
        describe: 'Explicit environment variable for the primary provider key',
      })
      .option('reuse-ssm', {
        type: 'string',
        describe: 'Explicit primary model-key SSM reference in the vault region',
      })
      .option('credential-env', {
        type: 'array',
        string: true,
        describe: 'Additional provider=VARIABLE credential selection; repeat per provider',
      })
      .option('credential-ssm', {
        type: 'array',
        string: true,
        describe: 'Additional provider=/parameter selection; repeat per provider',
      })
      .option('activate', {
        type: 'boolean',
        default: false,
        describe: 'Activate after staging with integrations still disconnected',
      })
      .option('yes', {
        type: 'boolean',
        default: false,
        describe: 'Approve the displayed AWS plan',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Emit filtered plan or operation metadata',
      }),
  handler: async (argv) => {
    try {
      await runCloneCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default cloneCommand;
