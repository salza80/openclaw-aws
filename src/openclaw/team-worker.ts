import { isDeepStrictEqual } from 'node:util';
import { archiveMemberIdentity, parseMembers, type BackupMember } from './backup-contract.js';
import { modelObject, modelText } from './model-contract.js';
import type { NativeModelClient } from './model-control.js';
import {
  parseTeamJob,
  parseTeamPreflight,
  type TeamJob,
  type TeamWorkerMode,
} from './team-contract.js';
import { teamMembers, teamDefinitionDigest } from './team-definition.js';
import { teamConfigurationPatch, teamConfigurationMatches } from './team-configuration.js';
import {
  inspectTeamInstructions,
  writeTeamInstructions,
  assertTeamInstructions,
} from './team-workspaces.js';
import { teamHostJournal, teamHostOwnership } from './team-journal.js';

export interface TeamWorkerHost {
  home: string;
  identify(): Promise<void>;
  client: NativeModelClient;
  members(): Promise<BackupMember[]>;
}
async function snapshot(client: NativeModelClient) {
  const row = modelObject(await client.call('config.get', {}));
  if (row.valid === false) throw new Error('Native team configuration is invalid');
  return { hash: modelText(row.hash), config: modelObject(row.config) };
}
function desiredMembers(job: TeamJob, home: string, existing: BackupMember[]) {
  const main = existing.find((member) => member.id === 'main');
  if (!main) throw new Error('A native main coordinator is required for this team');
  return teamMembers(job.definition, home, main);
}
/** Caller holds the shared host flock. No model prompts or raw native output
 * enter the job/journal/result. One revision-checked native patch creates the
 * roster and communication policy; an unacknowledged patch is never replayed. */
export async function runTeamOperation(input: unknown, host: TeamWorkerHost, mode: TeamWorkerMode) {
  const job = parseTeamJob(input);
  if (!['execute', 'inspect', 'resume', 'abort'].includes(mode))
    throw new Error('Unsupported native team control mode');
  await host.identify();
  const base = {
    schemaVersion: 1,
    operationId: job.operationId,
    teamId: job.teamId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    definitionDigest: teamDefinitionDigest(job.definition),
    inferenceVerified: false,
  };
  if (job.action.kind === 'preview') {
    if (mode !== 'execute') throw new Error('Read-only team preview cannot be resumed');
    const before = await snapshot(host.client);
    const existingMembers = archiveMemberIdentity(parseMembers(await host.members()));
    const owned = await teamHostOwnership(host.home, job, false);
    if (!owned && (existingMembers.length !== 1 || existingMembers[0].id !== 'main'))
      throw new Error(
        'Team setup requires its dedicated fresh host; unrelated agents were retained',
      );
    const members = desiredMembers(job, host.home, existingMembers);
    teamConfigurationPatch({
      definition: job.definition,
      home: host.home,
      members,
      existingMembers,
      config: before.config,
    });
    const instructions = await inspectTeamInstructions(
      host.home,
      job.definition,
      members,
      existingMembers.map((member) => member.id),
    );
    const reloadOff =
      modelObject(modelObject(before.config.gateway ?? {}).reload ?? {}).mode === 'off';
    const after = await snapshot(host.client);
    if (after.hash !== before.hash) throw new Error('Team configuration changed during preview');
    await host.client.health();
    return {
      ...base,
      recordedPhase: 'preview' as const,
      checkedAt: new Date().toISOString(),
      gatewayHealthy: true,
      requestedConfigurationVerified: false,
      maintenanceHeld: false,
      members: archiveMemberIdentity(members),
      preflight: parseTeamPreflight(
        { expectedHash: before.hash, existingMembers, instructions, reloadOff },
        job.definition,
      ),
    };
  }
  const action = job.action;
  let journal: Awaited<ReturnType<typeof teamHostJournal>>;
  try {
    journal = await teamHostJournal(host.home, job, mode === 'execute');
  } catch (error) {
    if (mode === 'inspect' && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return {
        ...base,
        recordedPhase: 'not-started' as const,
        checkedAt: new Date().toISOString(),
        gatewayHealthy: null,
        requestedConfigurationVerified: false,
        maintenanceHeld: false,
      };
    throw error;
  }
  const members = desiredMembers(job, host.home, action.existingMembers);
  const verified = async () => {
    const current = await snapshot(host.client);
    const observed = archiveMemberIdentity(parseMembers(await host.members()));
    if (!isDeepStrictEqual(observed, archiveMemberIdentity(members)))
      throw new Error('Native team roster differs from its approved complete roster');
    const patch = teamConfigurationPatch({
      definition: job.definition,
      home: host.home,
      members,
      config: current.config,
    });
    if (!teamConfigurationMatches(current.config, patch))
      throw new Error('Native team settings differ from the approved definition');
    await assertTeamInstructions(host.home, job.definition, members);
    await host.client.health();
    const runtime = modelObject(await host.client.call('agents.list', {}));
    if (
      !Array.isArray(runtime.agents) ||
      !isDeepStrictEqual(
        runtime.agents.map((agent) => modelText(modelObject(agent).id, 64)).sort(),
        members.map((member) => member.id).sort(),
      )
    )
      throw new Error('Native Gateway has not published the complete team roster');
    return current.hash;
  };
  const report = async (
    recordedPhase: string,
    requestedConfigurationVerified = false,
    configHash?: string,
  ) => ({
    ...base,
    recordedPhase,
    checkedAt: new Date().toISOString(),
    gatewayHealthy: requestedConfigurationVerified ? true : null,
    requestedConfigurationVerified,
    maintenanceHeld: await journal.ownsMaintenance(),
    members: archiveMemberIdentity(members),
    ...(configHash ? { configHash } : {}),
  });
  if (mode === 'inspect') {
    const phase = (await journal.read('aborted'))
      ? 'aborted'
      : (await journal.read('complete'))
        ? 'complete'
        : (await journal.read('configuration-intent'))
          ? 'configuration-uncertain'
          : (await journal.read('started'))
            ? 'preparing'
            : 'not-started';
    let configHash: string | undefined;
    if (phase !== 'aborted') {
      try {
        configHash = await verified();
      } catch {
        /* Unknown/changed state is not readiness. */
      }
    }
    return report(phase, Boolean(configHash), configHash);
  }
  if (await journal.read('aborted'))
    throw new Error('Team operation was aborted; delayed setup was refused');
  if (await journal.read('complete')) {
    if (mode === 'abort')
      throw new Error(
        'Completed team setup cannot be aborted; use its normal lifecycle operations',
      );
    const configHash = await verified();
    if (await journal.ownsMaintenance()) await journal.release();
    return report('complete', true, configHash);
  }
  if (mode === 'abort') {
    if (await journal.read('configuration-intent'))
      throw new Error(
        'Native team configuration may be in flight; inspect/resume without replay instead of aborting',
      );
    await journal.claim();
    await journal.mark('aborted');
    await journal.release();
    return { ...(await report('aborted')), retainedInstructionFiles: true };
  }
  if (await journal.read('configuration-intent')) {
    if (mode !== 'resume')
      throw new Error(
        'Native team setup already started; resume verifies its result without another write',
      );
    const configHash = await verified();
    if (!(await journal.ownsMaintenance()))
      throw new Error('Interrupted team setup no longer owns host maintenance');
    await journal.mark('complete', { configHash });
    await journal.release();
    return report('complete', true, configHash);
  }
  const before = await snapshot(host.client);
  const existingMembers = archiveMemberIdentity(parseMembers(await host.members()));
  if (
    before.hash !== action.expectedHash ||
    !isDeepStrictEqual(existingMembers, action.existingMembers)
  )
    throw new Error('Team source revision or original roster changed after approval');
  const owned = await teamHostOwnership(host.home, job, false);
  if (!owned && (existingMembers.length !== 1 || existingMembers[0].id !== 'main'))
    throw new Error('This team does not own the existing native roster');
  const reloadOff =
    modelObject(modelObject(before.config.gateway ?? {}).reload ?? {}).mode === 'off';
  if (reloadOff && !action.allowRestart)
    throw new Error('Native reload is off; approve a controlled Gateway restart before team setup');
  const patch = teamConfigurationPatch({
    definition: job.definition,
    home: host.home,
    members,
    existingMembers,
    config: before.config,
  });
  await journal.claim();
  await journal.mark('started');
  await teamHostOwnership(host.home, job, true);
  await writeTeamInstructions({
    home: host.home,
    operationId: job.operationId,
    definition: job.definition,
    members,
    existing: existingMembers.map((member) => member.id),
    pins: action.instructions,
    beforeWrite: async (agentId) => {
      const name = 'instruction-' + agentId;
      const existed = Boolean(await journal.read(name));
      await journal.mark(name);
      return existed;
    },
  });
  if ((await snapshot(host.client)).hash !== action.expectedHash)
    throw new Error('Native team revision changed before configuration; no patch was sent');
  await assertTeamInstructions(host.home, job.definition, members);
  await journal.mark('configuration-intent');
  const response = modelObject(
    await host.client.call('config.patch', {
      baseHash: action.expectedHash,
      raw: JSON.stringify(patch),
      response: 'summary',
    }),
  );
  if (response.ok !== true)
    throw new Error(
      'Native team configuration was not acknowledged; inspect the original operation',
    );
  await journal.mark('configuration-acknowledged');
  if (reloadOff) await host.client.restart();
  const configHash = await verified();
  await journal.mark('complete', { configHash });
  await journal.release();
  return report('complete', true, configHash);
}
