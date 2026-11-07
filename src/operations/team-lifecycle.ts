import { isDeepStrictEqual } from 'node:util';
import { resolveAwsTarget, type AwsTarget } from '../aws/target.js';
import type { CommandContext } from '../cli/utils/context.js';
import { planArchive, createArchive, type ArchivePlan } from './archive.js';
import { readTeamState, saveTeamIdentityState } from './team-state.js';
import { buildCommandContext } from '../cli/utils/context.js';
import { inspectRecoverySource } from '../aws/recovery-source.js';
import { withDeploymentLock } from './lock.js';
import { inspectBackup } from './backup.js';
import { queryTeam } from './teams.js';
import { prepareRestore, stageRestore, resumeRestore, type RestorePlan } from './restore.js';
import { loadRestoreRecord } from './restore-record.js';
import { parseTeamRecovery, type TeamRecovery } from '../openclaw/team-recovery.js';
import { teamIdentity } from '../openclaw/team-recovery.js';
import { archiveMemberIdentity } from '../openclaw/backup-contract.js';

/** Single-host teams use exactly one whole-installation archive operation. */
export async function prepareTeamArchive(
  ctx: CommandContext,
  options: {
    vaultUri: string;
    operationId?: string;
    deleteConfig?: boolean;
  },
): Promise<ArchivePlan> {
  const state = await readTeamState(ctx.name);
  const current = await queryTeam(ctx);
  if (current.pendingControl || current.maintenanceHeld)
    throw new Error('Resolve pending host maintenance before archiving this team');
  if (
    !current.members ||
    !isDeepStrictEqual(
      current.members.map((member) => member.id).sort(),
      teamIdentity(state.teamId, state.definition)
        .roles.map((role) => role.nativeId)
        .sort(),
    )
  )
    throw new Error('Team archive does not own the complete native roster');
  return planArchive(ctx, { ...options, expectedMembers: archiveMemberIdentity(current.members) });
}
export { createArchive as archiveTeam };

export type TeamRestorePlan = RestorePlan & { team: TeamRecovery };
/** The canonical completed backup receipt carries stable role mapping and exact
 * native object versions; no source/local configuration is needed for intake. */
export async function prepareTeamRestore(
  options: Parameters<typeof prepareRestore>[0],
): Promise<TeamRestorePlan> {
  const plan = await prepareRestore(options);
  if (!plan.point.capture.credentials.team)
    throw new Error('Selected recovery point has no complete team ownership metadata');
  return {
    ...plan,
    team: parseTeamRecovery(plan.point.capture.credentials.team, plan.point.capture.members),
  };
}
export async function stageTeamRestore(
  plan: TeamRestorePlan,
  recoveryTarget: AwsTarget,
  options: Parameters<typeof stageRestore>[2] = {},
) {
  const team = parseTeamRecovery(plan.team, plan.point.capture.members);
  if (!isDeepStrictEqual(team, plan.point.capture.credentials.team))
    throw new Error('Team restore approval differs from the saved point');
  const record = await stageRestore(plan, recoveryTarget, options);
  await adoptRecoveredTeam(record.name, record.operationId, team);
  return record;
}
export async function resumeTeamRestore(
  operationId: string,
  options: Parameters<typeof resumeRestore>[1] = {},
) {
  const record = loadRestoreRecord(operationId);
  // Shared resume binds the original delivery, validates saved team policy
  // before activation and never creates an absent target implicitly.
  const capture =
    record.delivery?.job.backup.capture ??
    (
      await inspectBackup(
        await resolveAwsTarget({
          region: record.recovery.region,
          profile: record.recovery.profile,
        }),
        record.recovery.uri,
        record.recovery.pointId,
      )
    ).capture;
  if (!capture.credentials.team)
    throw new Error('Restore operation has no pinned team recovery point');
  const result = await resumeRestore(operationId, options);
  await adoptRecoveredTeam(result.name, operationId, capture.credentials.team);
  return result;
}
async function adoptRecoveredTeam(name: string, operationId: string, team: TeamRecovery) {
  const ctx = await buildCommandContext({ name });
  await withDeploymentLock(ctx, async () => {
    const source = await inspectRecoverySource(ctx);
    await saveTeamIdentityState(
      {
        deploymentName: name,
        stackId: source.stackId,
        instanceId: source.instanceId,
        roleId: source.role.id,
        account: ctx.target.account,
        region: ctx.target.region,
      },
      operationId,
      team,
    );
  });
}
