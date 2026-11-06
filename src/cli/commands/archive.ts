import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { buildCommandContext } from '../utils/context.js';
import { handleError, ValidationError } from '../utils/errors.js';
import { backupOperationId } from '../../operations/backup.js';
import {
  planArchive,
  createArchive,
  inspectArchive,
  resumeArchive,
  abortArchive,
  type ArchiveResult,
} from '../../operations/archive.js';

interface Args {
  action?: string;
  name?: string;
  vault: string;
  operationId?: string;
  region?: string;
  profile?: string;
  keepConfig?: boolean;
  yes?: boolean;
  json?: boolean;
}
async function approve(yes: boolean | undefined, message: string) {
  if (yes) return true;
  if (!process.stdin.isTTY)
    throw new ValidationError('Noninteractive archive changes require --yes');
  const { approved } = await prompts({
    type: 'confirm',
    name: 'approved',
    message,
    initial: false,
  });
  return approved === true;
}
export async function runArchiveCommand(argv: Args) {
  const action = argv.action ?? 'create';
  if (!['create', 'inspect', 'resume', 'abort'].includes(action))
    throw new ValidationError('Use archive, archive inspect, archive resume or archive abort');
  let output: unknown;
  if (action === 'create') {
    if (argv.region || argv.profile)
      throw new ValidationError(
        'Archive creation uses the named deployment AWS target; omit --region and --profile',
      );
    const ctx = await buildCommandContext({ name: argv.name });
    const plan = await planArchive(ctx, {
      vaultUri: argv.vault,
      operationId: argv.operationId,
      deleteConfig: !argv.keepConfig,
    });
    const preview = {
      operationId: plan.operationId,
      name: plan.name,
      account: ctx.target.account,
      region: ctx.target.region,
      sourceStackId: plan.deletion.source.stackId,
      instanceId: plan.deletion.source.instanceId,
      volumeId: plan.deletion.volumeId,
      agents: plan.expectedMembers,
      deleteResources: plan.deletion.source.resources,
      deleteParameters: plan.deletion.parameters.map((p) => p.name),
      deleteLocalConfig: plan.deleteConfig,
      retain: {
        vault: plan.vaultUri,
        independentRecoveryKey: true,
        defaultVpc: plan.config.network.useDefaultVpc,
        sharedBootstrap: true,
      },
      workflow:
        'Quiesce idle native work, hold the Gateway inactive, commit and independently verify one complete installation backup, then delete the owned deployment once. Retained backups, keys and shared resources remain billable.',
    };
    if (argv.json) console.error(JSON.stringify(preview, null, 2));
    else console.log(JSON.stringify(preview, null, 2));
    if (
      !(await approve(
        argv.yes,
        'Archive this whole deployment and remove its owned AWS resources?',
      ))
    )
      return;
    output = await createArchive(ctx, plan);
  } else {
    if (argv.name || argv.keepConfig)
      throw new ValidationError(
        'Archive recovery uses its operation ID and independent vault, not a local deployment name',
      );
    if (!argv.operationId || !argv.region)
      throw new ValidationError(
        'Archive recovery requires --operation-id, --vault and --region; --profile is optional',
      );
    const options = {
      operationId: backupOperationId(argv.operationId),
      vaultUri: argv.vault,
      region: argv.region,
      profile: argv.profile,
    };
    if (action === 'inspect') output = await inspectArchive(options);
    else {
      console.error(
        `${action === 'resume' ? 'Resume the recorded archive, including committed teardown' : 'Abort before committed teardown and restore the original service state'} in ${argv.region}, vault ${argv.vault}, operation ${argv.operationId}. Retain the independent recovery point.`,
      );
      if (
        !(await approve(
          argv.yes,
          action === 'resume'
            ? 'Resume this archive operation?'
            : 'Abort this archive before teardown?',
        ))
      )
        return;
      output = action === 'resume' ? await resumeArchive(options) : await abortArchive(options);
    }
  }
  if (argv.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(JSON.stringify(output, null, 2));
    if (
      (output as ArchiveResult).recordedPhase === 'archived' &&
      typeof (output as ArchiveResult).restoreCommand === 'string'
    ) {
      const completed = output as ArchiveResult;
      console.log(
        `Restore: ${completed.restoreCommand}\nIndependent copy: ${completed.cloneCommand}\nRetained backup/key/shared resources may still incur charges.`,
      );
    }
  }
  return output;
}
export const archiveCommand: CommandModule<{}, Args> = {
  command: 'archive [action]',
  describe: 'Verify a complete recovery backup, then remove the owned AWS deployment',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['create', 'inspect', 'resume', 'abort'],
        default: 'create',
      })
      .option('name', { type: 'string', describe: 'Deployment name for a new whole-host archive' })
      .option('vault', {
        type: 'string',
        demandOption: true,
        describe: 'Independent registered S3 vault URI',
      })
      .option('operation-id', {
        type: 'string',
        describe: 'Stable archive UUID; required for inspect/resume/abort',
      })
      .option('region', {
        type: 'string',
        describe: 'Explicit recovery region when local configuration is absent',
      })
      .option('profile', {
        type: 'string',
        describe: 'AWS profile for recovery from the independent vault',
      })
      .option('keep-config', {
        type: 'boolean',
        default: false,
        describe: 'Keep local source configuration after confirmed teardown',
      })
      .option('yes', {
        type: 'boolean',
        default: false,
        describe: 'Approve the concrete archive or recovery action',
      })
      .option('json', { type: 'boolean', default: false }),
  handler: async (argv) => {
    try {
      await runArchiveCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default archiveCommand;
