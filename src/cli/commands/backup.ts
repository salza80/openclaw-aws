import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { buildCommandContext } from '../utils/context.js';
import { resolveAwsTarget } from '../../aws/target.js';
import { parseVaultUri } from '../../aws/recovery-store.js';
import {
  backupOperationId,
  createBackup,
  inspectBackup,
  listBackups,
  verifyBackup,
} from '../../operations/backup.js';
import { handleError, ValidationError } from '../utils/errors.js';

interface BackupArgs {
  action: string;
  id?: string;
  name?: string;
  vault: string;
  region?: string;
  profile?: string;
  label?: string;
  operationId?: string;
  yes?: boolean;
  json?: boolean;
}
export async function runBackupCommand(argv: BackupArgs) {
  if (!['create', 'list', 'inspect', 'verify'].includes(argv.action))
    throw new ValidationError('Use backup create, list, inspect or verify');
  parseVaultUri(argv.vault);
  if (['inspect', 'verify'].includes(argv.action) && !argv.id)
    throw new ValidationError('Select an explicit recovery point ID');
  if (argv.id) backupOperationId(argv.id);
  if (['create', 'list'].includes(argv.action) && argv.id)
    throw new ValidationError('This backup operation does not accept a recovery point ID');
  let result: unknown;
  if (argv.action === 'create') {
    if (argv.region || argv.profile)
      throw new ValidationError(
        'Backup creation uses the named deployment AWS target; omit --region and --profile',
      );
    const ctx = await buildCommandContext({ name: argv.name });
    const operationId = backupOperationId(argv.operationId);
    const plan = `Back up the complete OpenClaw installation '${ctx.name}' in ${ctx.target.account}/${ctx.target.region} to ${argv.vault}. Attach source-prefix storage/key access, install the pinned backup transport, briefly stop the Gateway, capture native state and credentials, verify the remote archive and restore service state. The vault must already exist. Recovery data and its independent key remain billable after instance deletion. Operation: ${operationId}.`;
    if (argv.json) console.error(plan);
    else console.log(plan);
    if (!argv.yes) {
      if (!process.stdin.isTTY)
        throw new ValidationError('Noninteractive backup creation requires --yes');
      const { approved } = await prompts({
        type: 'confirm',
        name: 'approved',
        message: 'Create this recovery point?',
        initial: false,
      });
      if (!approved) return;
    }
    result = await createBackup(ctx, {
      vaultUri: argv.vault,
      operationId,
      label: argv.label,
      progress: (message) => console.error(message),
    });
  } else {
    if (!argv.region)
      throw new ValidationError(
        'Recovery reads require an explicit --region and use no local deployment configuration',
      );
    if (argv.name || argv.label || argv.operationId)
      throw new ValidationError('Recovery reads use --vault, --region and optional --profile only');
    const target = await resolveAwsTarget({ region: argv.region, profile: argv.profile });
    result =
      argv.action === 'list'
        ? await listBackups(target, argv.vault)
        : argv.action === 'inspect'
          ? await inspectBackup(target, argv.vault, argv.id!)
          : await verifyBackup(target, argv.vault, argv.id!);
  }
  // Operations expose filtered metadata only; native command output and secrets stay private.
  if (argv.json) console.log(JSON.stringify(result, null, 2));
  else if (Array.isArray(result)) {
    if (!result.length) console.log('No completed recovery points.');
    for (const point of result)
      console.log(
        `${point.id}  ${point.completedAt}  ${point.source.stackName}${point.label ? `  ${point.label}` : ''}`,
      );
  } else {
    const data = result as Record<string, unknown>;
    console.log(
      `${argv.action === 'verify' ? 'Verified' : 'Recovery point'}: ${data.id}\nVault: ${argv.vault}`,
    );
    if (argv.action !== 'verify') console.log(JSON.stringify(result, null, 2));
    if (
      argv.action === 'create' &&
      (result as Awaited<ReturnType<typeof createBackup>>).capture.gateway.restored === false
    )
      console.error(
        'Recovery point verified, but Gateway health was not restored. Inspect the retained host maintenance record before any further mutation.',
      );
  }
}
export const backupCommand: CommandModule<{}, BackupArgs> = {
  command: 'backup <action> [id]',
  describe: 'Create or discover independently retained native OpenClaw recovery points',
  builder: (yargs) =>
    yargs
      .positional('action', {
        choices: ['create', 'list', 'inspect', 'verify'] as const,
        type: 'string',
        demandOption: true,
      })
      .positional('id', { type: 'string', describe: 'Explicit completed recovery point ID' })
      .option('vault', {
        type: 'string',
        demandOption: true,
        describe: 'Independent s3://bucket/vault-prefix',
      })
      .option('name', { type: 'string', describe: 'Source deployment for create' })
      .option('region', { type: 'string', describe: 'Explicit AWS region for clean-client reads' })
      .option('profile', {
        type: 'string',
        describe: 'Operator AWS profile for clean-client reads',
      })
      .option('label', { type: 'string', describe: 'Optional nonsecret recovery point label' })
      .option('operation-id', {
        type: 'string',
        describe: 'Resume a specific create operation without stealing host maintenance',
      })
      .option('yes', {
        type: 'boolean',
        default: false,
        describe: 'Approve the displayed capture plan',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Emit filtered recovery metadata as JSON',
      }),
  handler: async (argv) => {
    try {
      await runBackupCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default backupCommand;
