import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { cleanupRestore } from '../../operations/restore-cleanup.js';
import { resolveAwsTarget } from '../../aws/target.js';
import { prepareRestore, resumeRestore, stageRestore } from '../../operations/restore.js';
import { loadRestoreRecord, type RestoreRecord } from '../../operations/restore-record.js';
import { handleError, ValidationError } from '../utils/errors.js';
import { backupOperationId } from '../../operations/backup.js';
import { parseVaultUri } from '../../aws/recovery-store.js';

interface RestoreArgs {
  action?: string;
  from?: string;
  vault?: string;
  region?: string;
  profile?: string;
  targetRegion?: string;
  targetProfile?: string;
  name?: string;
  instanceType?: string;
  volumeGib?: number;
  operationId?: string;
  activate?: boolean;
  yes?: boolean;
  json?: boolean;
}
async function approve(argv: RestoreArgs, plan: string) {
  console.error(plan);
  if (argv.yes) return true;
  if (!process.stdin.isTTY)
    throw new ValidationError(
      'Noninteractive restoration requires --yes to approve the displayed AWS plan',
    );
  const { approved } = await prompts({
    type: 'confirm',
    name: 'approved',
    message: 'Continue this restore operation?',
    initial: false,
  });
  return approved === true;
}
function publicRecord(record: RestoreRecord) {
  return {
    operationId: record.operationId,
    name: record.name,
    recordedPhase: record.phase,
    backup: { id: record.recovery.pointId, vault: record.recovery.uri },
    region: record.config.aws.region,
    target: record.target,
    memberCount: record.activation?.memberCount ?? record.result?.memberCount,
    recordedSessionHolds: record.activation?.heldSessionCount ?? record.result?.heldSessionCount,
    permissionCleanupPending: record.permissionCleanupPending ?? false,
    ...(record.bedrock
      ? {
          bedrock: {
            inferenceRegion: record.bedrock.intent.inferenceRegion,
            invocationRouteCount: record.bedrock.intent.models.length,
            recordedIamPhase: record.bedrockIam?.phase ?? 'not-reviewed',
            policyStack: record.bedrockIam?.access.stackId ?? record.bedrockIam?.access.stackName,
            changeSetId: record.bedrockIam?.access.changeSetId,
          },
        }
      : {}),
  };
}
export async function runRestoreCommand(argv: RestoreArgs) {
  const action = argv.action ?? 'stage';
  if (!['stage', 'resume', 'activate', 'inspect', 'cleanup'].includes(action))
    throw new ValidationError('Use restore stage, resume, activate, inspect or cleanup');
  let record: RestoreRecord;
  if (action === 'stage') {
    if (!argv.from || !argv.vault || !argv.region)
      throw new ValidationError(
        'Restore requires --from <backup-id>, --vault <s3-uri> and --region <vault-region>',
      );
    backupOperationId(argv.from);
    parseVaultUri(argv.vault);
    const recoveryTarget = await resolveAwsTarget({ region: argv.region, profile: argv.profile });
    const plan = await prepareRestore({
      recoveryTarget,
      vaultUri: argv.vault,
      pointId: argv.from,
      name: argv.name,
      region: argv.targetRegion,
      profile: argv.targetProfile ?? argv.profile,
      instanceType: argv.instanceType,
      volumeGiB: argv.volumeGib,
      operationId: argv.operationId,
    });
    if (plan.sourcePresence.kind !== 'gone')
      throw new ValidationError(
        'The source identity is still present. Use independent cloning to keep both installations, or remove the source after a verified backup before restoring it.',
      );
    const details = `Restore ${argv.from} from ${argv.vault} as '${plan.context.name}' in AWS ${plan.context.target.account}/${plan.context.target.region}. Create one ${plan.context.config.instance.type} EC2 host with a ${plan.bootstrap.volumeGiB} GiB encrypted root disk, its IAM/network resources and fresh target credentials; attach temporary vault read/provider-import permissions. Install the recorded runtime and recover every saved member. ${argv.activate ? 'Activate the Gateway after validation; channels, schedules, hooks and restored sessions remain held.' : 'Leave the Gateway masked and inactive for separate activation.'} Operation: ${plan.operationId}. AWS compute/storage remain billable until cleanup.\n${plan.prerequisites.join('\n')}`;
    if (!(await approve(argv, details))) return;
    record = await stageRestore(plan, recoveryTarget, {
      progress: (message) => console.error(message),
    });
    if (argv.activate)
      record = await resumeRestore(record.operationId, {
        activate: true,
        progress: (message) => console.error(message),
      });
  } else {
    if (!argv.operationId)
      throw new ValidationError('Select an existing restore with --operation-id <uuid>');
    if (
      argv.from ||
      argv.vault ||
      argv.region ||
      argv.profile ||
      argv.targetRegion ||
      argv.targetProfile ||
      argv.name ||
      argv.instanceType ||
      argv.volumeGib !== undefined ||
      argv.activate
    )
      throw new ValidationError(
        'Existing operations use their recorded target and recovery settings; select --operation-id only',
      );
    record = loadRestoreRecord(argv.operationId);
    if (action === 'cleanup') {
      if (
        !(await approve(
          argv,
          `Delete the AWS stack '${record.config.stack.name}' and every operation-owned imported credential for restore ${record.operationId} in ${record.config.aws.region}. All instance data will be lost. The independent backup vault and recovery key are retained.`,
        ))
      )
        return;
      await cleanupRestore(record.operationId);
      console.log('Restore target and owned credentials removed. The recovery point is retained.');
      return;
    }
    if (action !== 'inspect') {
      if (
        !(await approve(
          argv,
          `${action === 'activate' ? 'Activate the validated Gateway while integrations and restored sessions remain held' : 'Resume the existing restore and reconcile its recorded state'}: '${record.name}', ${record.config.aws.region}, operation ${record.operationId}, instance ${record.target?.instanceId ?? 'pending bootstrap ownership verification'}. Reattach temporary recovery permissions, verify the existing target and remove those permissions on success.`,
        ))
      )
        return;
      record = await resumeRestore(argv.operationId, {
        activate: action === 'activate',
        progress: (message) => console.error(message),
      });
    }
  }
  if (argv.json) console.log(JSON.stringify(publicRecord(record), null, 2));
  else {
    console.log(
      `Restore ${record.operationId}: ${action === 'inspect' ? 'recorded ' : ''}${record.phase}\nDeployment: ${record.name}\nRegion: ${record.config.aws.region}${record.target ? `\nInstance: ${record.target.instanceId}` : ''}`,
    );
    if (record.phase === 'ready-inactive')
      console.log(
        `Activate after review: openclaw-aws restore activate --operation-id ${record.operationId}`,
      );
    if (record.phase === 'active-held' && action !== 'inspect')
      console.log(
        'Gateway health verified. Review channel pairing and native integration settings before enabling channels, schedules or held sessions.',
      );
    if (record.permissionCleanupPending)
      console.log('Temporary recovery permission cleanup is pending; resume this operation.');
  }
}
export const restoreCommand: CommandModule<{}, RestoreArgs> = {
  command: 'restore [action]',
  describe: 'Restore a verified recovery point onto a fresh AWS host',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['stage', 'resume', 'activate', 'inspect', 'cleanup'] as const,
        default: 'stage',
      })
      .option('from', { type: 'string', describe: 'Explicit completed recovery point UUID' })
      .option('vault', { type: 'string', describe: 'Independent s3://bucket/vault-prefix' })
      .option('region', { type: 'string', describe: 'Vault region for clean-client recovery' })
      .option('profile', { type: 'string', describe: 'Vault operator AWS profile' })
      .option('target-region', { type: 'string', describe: 'Override the saved target region' })
      .option('target-profile', {
        type: 'string',
        describe: 'Target AWS profile in the same account',
      })
      .option('name', {
        type: 'string',
        describe: 'Unused deployment name; defaults to the saved name',
      })
      .option('instance-type', {
        type: 'string',
        describe: 'Override the saved compatible x86_64 instance type',
      })
      .option('volume-gib', {
        type: 'number',
        describe: 'Root disk GiB; at least the saved disk and required staging capacity',
      })
      .option('operation-id', {
        type: 'string',
        describe:
          'Existing operation for resume/activate/inspect/cleanup, or explicit new operation UUID',
      })
      .option('activate', {
        type: 'boolean',
        default: false,
        describe: 'Activate after staging, with integrations and restored sessions still held',
      })
      .option('yes', {
        type: 'boolean',
        default: false,
        describe: 'Approve the displayed restore plan',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Emit filtered restore progress metadata',
      }),
  handler: async (argv) => {
    try {
      await runRestoreCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default restoreCommand;
