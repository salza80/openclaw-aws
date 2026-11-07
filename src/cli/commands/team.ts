import type { CommandModule } from 'yargs';
import prompts from 'prompts';
import { buildCommandContext } from '../utils/context.js';
import { handleError, ValidationError } from '../utils/errors.js';
import { readTeamFile } from '../utils/team-file.js';
import { createFreshTeam, resumeFreshTeam, enableTeamBedrock } from '../utils/team-create-flow.js';
import { prepareTeam, applyTeam, queryTeam, inspectTeamOperation } from '../../operations/teams.js';
import { readTeamState } from '../../operations/team-state.js';
import {
  prepareTeamArchive,
  archiveTeam,
  prepareTeamRestore,
  stageTeamRestore,
  resumeTeamRestore,
} from '../../operations/team-lifecycle.js';
import { inspectArchive, resumeArchive } from '../../operations/archive.js';
import { createBackup } from '../../operations/backup.js';
import { resolveAwsTarget } from '../../aws/target.js';

interface TeamArgs {
  action: string;
  name?: string;
  file?: string;
  provider?: string;
  model?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  bedrockRegion?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  operationId?: string;
  vault?: string;
  from?: string;
  targetRegion?: string;
  targetProfile?: string;
  volumeGib?: number;
  allowRestart?: boolean;
  keepConfig?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}
async function approve(argv: TeamArgs, details: string) {
  console.error(details);
  if (argv.yes) return true;
  if (!process.stdin.isTTY)
    throw new ValidationError(
      'Noninteractive team mutations require --yes after reviewing the plan',
    );
  return (
    (
      await prompts({
        type: 'confirm',
        name: 'approved',
        message: 'Continue this team operation?',
        initial: false,
      })
    ).approved === true
  );
}
function required(value: string | undefined, label: string) {
  if (!value) throw new ValidationError(`Team operation requires ${label}`);
  return value;
}
export async function runTeamCommand(argv: TeamArgs) {
  const common = ['yes', 'json'];
  const allowed: Record<string, string[]> = {
    create: [
      'name',
      'file',
      'provider',
      'model',
      'region',
      'profile',
      'instanceType',
      'bedrockRegion',
      'cloudflareAccountId',
      'cloudflareGatewayId',
    ],
    'create-resume': ['operationId', 'bedrockRegion'],
    configure: ['name', 'file', 'operationId', 'allowRestart', 'bedrockRegion', 'dryRun'],
    status: ['name'],
    inspect: ['name', 'operationId'],
    resume: ['name', 'operationId'],
    abort: ['name', 'operationId'],
    backup: ['name', 'vault', 'operationId'],
    archive: ['name', 'vault', 'operationId', 'keepConfig', 'dryRun'],
    'archive-resume': ['vault', 'operationId', 'region', 'profile'],
    'archive-inspect': ['vault', 'operationId', 'region', 'profile'],
    restore: [
      'name',
      'vault',
      'from',
      'region',
      'profile',
      'targetRegion',
      'targetProfile',
      'instanceType',
      'volumeGib',
      'operationId',
      'dryRun',
    ],
    'restore-resume': ['operationId'],
    activate: ['operationId'],
  };
  const fields = [
    'name',
    'file',
    'provider',
    'model',
    'region',
    'profile',
    'instanceType',
    'bedrockRegion',
    'cloudflareAccountId',
    'cloudflareGatewayId',
    'operationId',
    'vault',
    'from',
    'targetRegion',
    'targetProfile',
    'volumeGib',
    'allowRestart',
    'keepConfig',
    'dryRun',
    ...common,
  ];
  if (!allowed[argv.action]) throw new ValidationError('Unknown team action; see team --help');
  for (const key of fields) {
    const value = argv[key as keyof TeamArgs];
    if (
      value !== undefined &&
      value !== false &&
      ![...allowed[argv.action], ...common].includes(key)
    )
      throw new ValidationError(`${key} does not apply to team ${argv.action}`);
  }
  let result: unknown;
  const approvePlan = (details: string) => approve(argv, details);
  const options = { inferenceRegion: argv.bedrockRegion, approve: approvePlan };
  if (argv.dryRun && !['configure', 'archive', 'restore'].includes(argv.action))
    throw new ValidationError('--dry-run applies to team configure, archive or restore');
  if (argv.action === 'create') {
    if (argv.json)
      throw new ValidationError('Team create uses the interactive setup output; omit --json');
    const definition = await readTeamFile(required(argv.file, '--file'));
    console.error(
      `Create one dedicated EC2/Gateway with ${definition.members.length} native agents. Each role has a private workspace; OS/IAM permissions belong to the shared host.`,
    );
    result = await createFreshTeam(
      { ...argv, name: required(argv.name, 'a deployment name') },
      definition,
      options,
    );
  } else if (argv.action === 'create-resume') {
    if (
      !(await approvePlan(
        'Resume only the original ready team host; never launch a replacement or replay uncertain native writes.',
      ))
    )
      return;
    result = await resumeFreshTeam(required(argv.operationId, '--operation-id'), options);
  } else if (
    ['status', 'configure', 'inspect', 'resume', 'abort', 'backup', 'archive'].includes(argv.action)
  ) {
    const ctx = await buildCommandContext({ name: required(argv.name, 'a team deployment name') });
    if (argv.action === 'status') result = await queryTeam(ctx);
    else if (argv.action === 'configure') {
      const definition = await readTeamFile(required(argv.file, '--file'));
      const state = await readTeamState(ctx.name);
      if (!argv.dryRun && !(await enableTeamBedrock(ctx, definition, options))) return;
      const plan = await prepareTeam(ctx, {
        definition,
        teamId: state.teamId,
        operationId: argv.operationId,
        allowRestart: argv.allowRestart,
      });
      if (argv.dryRun) result = plan;
      else {
        if (
          !(await approvePlan(
            `Configure this complete native roster on EC2 ${plan.job.target.instanceId}; adding a role reuses the host. Existing native model policy applies.\n${JSON.stringify(plan, null, 2)}`,
          ))
        )
          return;
        result = await applyTeam(ctx, plan);
      }
    } else if (['inspect', 'resume', 'abort'].includes(argv.action)) {
      if (
        argv.action !== 'inspect' &&
        !(await approvePlan(
          `${argv.action} the original team setup operation. An abort retains staged files and any already verified native roster; it cannot roll back an uncertain native write.`,
        ))
      )
        return;
      result = await inspectTeamOperation(ctx, required(argv.operationId, '--operation-id'), {
        mode: argv.action as 'inspect' | 'resume' | 'abort',
      });
    } else if (argv.action === 'backup') {
      const current = await queryTeam(ctx);
      if (current.pendingControl || current.maintenanceHeld)
        throw new ValidationError('Resolve pending team maintenance before backup');
      if (
        !(await approvePlan(
          `Take one complete installation backup of the team on ${ctx.name} into ${required(argv.vault, '--vault')}; retain the running host and recovery storage charges.`,
        ))
      )
        return;
      result = await createBackup(ctx, {
        vaultUri: argv.vault!,
        operationId: argv.operationId,
        label: 'team',
      });
    } else {
      const plan = await prepareTeamArchive(ctx, {
        vaultUri: required(argv.vault, '--vault'),
        operationId: argv.operationId,
        deleteConfig: !argv.keepConfig,
      });
      if (argv.dryRun) result = plan;
      else {
        if (
          !(await approvePlan(
            `Archive the WHOLE team: hold all native writers, verify one complete backup, and delete EC2/disk/shared host resources and the owned source parameters once. The independent vault/key/shared resources remain billable.\n${JSON.stringify(plan, null, 2)}`,
          ))
        )
          return;
        result = await archiveTeam(ctx, plan);
      }
    }
  } else if (['archive-resume', 'archive-inspect'].includes(argv.action)) {
    const scope = {
      vaultUri: required(argv.vault, '--vault'),
      operationId: required(argv.operationId, '--operation-id'),
      region: required(argv.region, '--region (vault region)'),
      profile: argv.profile,
    };
    if (argv.action === 'archive-resume') {
      if (
        !(await approvePlan(
          `Resume the single whole-host archive ${scope.operationId}; retain the original recovery point and pinned teardown identity. This may finish deleting the source.`,
        ))
      )
        return;
      result = await resumeArchive(scope);
    } else result = await inspectArchive(scope);
  } else if (argv.action === 'restore') {
    const recoveryTarget = await resolveAwsTarget({
      region: required(argv.region, '--region (vault region)'),
      profile: argv.profile,
    });
    const plan = await prepareTeamRestore({
      recoveryTarget,
      vaultUri: required(argv.vault, '--vault'),
      pointId: required(argv.from, '--from (backup UUID)'),
      name: argv.name,
      region: argv.targetRegion,
      profile: argv.targetProfile ?? argv.profile,
      instanceType: argv.instanceType,
      volumeGiB: argv.volumeGib,
      operationId: argv.operationId,
    });
    const preview = {
      operationId: plan.operationId,
      name: plan.context.name,
      team: plan.team,
      region: plan.context.target.region,
      sourcePresence: plan.sourcePresence.kind,
      members: plan.point.capture.members,
      prerequisites: plan.prerequisites,
      target: plan.bootstrap,
    };
    if (argv.dryRun) result = preview;
    else {
      if (
        !(await approvePlan(
          `Restore this complete team onto ONE new inactive host. Verify native roles/policies/models, rotate target credentials and retain historical work/integration holds. Activation is a separate command.\n${JSON.stringify(preview, null, 2)}`,
        ))
      )
        return;
      const record = await stageTeamRestore(plan, recoveryTarget);
      result = {
        operationId: record.operationId,
        name: record.name,
        recordedPhase: record.phase,
        target: record.target,
      };
    }
  } else if (['restore-resume', 'activate'].includes(argv.action)) {
    if (
      !(await approvePlan(
        argv.action === 'activate'
          ? 'Activate the certified restored team after revalidating its native coordination/model settings and historical work holds. Channels/schedules remain paused.'
          : 'Resume only the original inactive team recovery; no new host or fresh onboarding.',
      ))
    )
      return;
    const record = await resumeTeamRestore(required(argv.operationId, '--operation-id'), {
      activate: argv.action === 'activate',
    });
    result = {
      operationId: record.operationId,
      name: record.name,
      recordedPhase: record.phase,
      target: record.target,
    };
  } else throw new ValidationError('Unknown team action; see team --help');
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}
export const teamCommand: CommandModule<{}, TeamArgs> = {
  command: 'team <action> [name]',
  describe: 'Create and manage a team of native agents on one AWS EC2/Gateway',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        demandOption: true,
        choices: [
          'create',
          'create-resume',
          'configure',
          'status',
          'inspect',
          'resume',
          'abort',
          'backup',
          'archive',
          'archive-resume',
          'archive-inspect',
          'restore',
          'restore-resume',
          'activate',
        ],
      })
      .positional('name', {
        type: 'string',
        describe: 'Hosting deployment (new target name for restore)',
      })
      .option('file', { type: 'string', describe: 'Nonsecret native team YAML/JSON definition' })
      .option('provider', {
        type: 'string',
        describe: 'Initial create provider; defaults to openrouter',
      })
      .option('model', { type: 'string', describe: 'Initial fresh native model' })
      .option('region', { type: 'string', describe: 'Create region, or recovery vault region' })
      .option('profile', { type: 'string', describe: 'AWS credential profile' })
      .option('instance-type', {
        type: 'string',
        describe: 'Shared EC2 capacity; minimum 2 GiB, size for concurrent work',
      })
      .option('bedrock-region', { type: 'string', describe: 'Optional Bedrock inference region' })
      .option('cloudflare-account-id', { type: 'string' })
      .option('cloudflare-gateway-id', { type: 'string' })
      .option('operation-id', {
        type: 'string',
        describe: 'Original operation UUID for inspect/resume/abort',
      })
      .option('vault', {
        type: 'string',
        describe: 'Independent s3://bucket/prefix recovery vault',
      })
      .option('from', { type: 'string', describe: 'Exact verified backup UUID to restore' })
      .option('target-region', { type: 'string', describe: 'Restore deployment region' })
      .option('target-profile', { type: 'string', describe: 'Restore deployment profile' })
      .option('volume-gib', { type: 'number', describe: 'Restore disk capacity including staging' })
      .option('allow-restart', {
        type: 'boolean',
        describe: 'Approve controlled restart for native team configure',
      })
      .option('keep-config', {
        type: 'boolean',
        describe: 'Retain local configuration after archive',
      })
      .option('dry-run', {
        type: 'boolean',
        describe: 'Preview configure/archive/restore without mutation',
      })
      .option('yes', {
        type: 'boolean',
        alias: 'y',
        default: false,
        describe: 'Approve the displayed operation plan(s)',
      })
      .option('json', {
        type: 'boolean',
        describe: 'Machine-readable result (except fresh interactive create)',
      }),
  handler: async (argv) => {
    try {
      await runTeamCommand(argv);
    } catch (error) {
      handleError(error);
    }
  },
};
export default teamCommand;
