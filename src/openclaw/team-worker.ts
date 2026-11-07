import { isDeepStrictEqual } from 'node:util';
import { archiveMemberIdentity, parseMembers, type BackupMember } from './backup-contract.js';
import { modelObject, modelText } from './model-contract.js';
import { privateModelJson } from './model-journal.js';
import path from 'node:path';
import {
  assertNativeModelChoice,
  inspectModelSelection,
  nativeModelSetting,
  type NativeModelClient,
} from './model-control.js';
import {
  parseTeamJob,
  parseTeamPreflight,
  type TeamJob,
  type TeamWorkerMode,
} from './team-contract.js';
import { teamMembers, teamDefinitionDigest } from './team-definition.js';
import {
  teamConfigurationPatch,
  teamConfigurationMatches,
  teamModelPatch,
  teamModelProjection,
  teamModelChoices,
} from './team-configuration.js';
import {
  inspectTeamInstructions,
  writeTeamInstructions,
  assertTeamInstructions,
} from './team-workspaces.js';
import { teamHostJournal, teamHostOwnership } from './team-journal.js';
import { publishTeamMembership, teamIdentity } from './team-recovery.js';

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
  if (job.action.kind === 'status') {
    if (mode !== 'execute') throw new Error('Read-only team status cannot be resumed');
    if (!(await teamHostOwnership(host.home, job, false)))
      throw new Error('Team does not own this hosting deployment');
    const members = archiveMemberIdentity(parseMembers(await host.members()));
    if (!isDeepStrictEqual(members, archiveMemberIdentity(desiredMembers(job, host.home, members))))
      throw new Error('Native roster contains undeclared or changed team members');
    await host.client.health();
    const models = [];
    for (const member of members) {
      const observation = await inspectModelSelection(host.client, {
        kind: 'agent',
        agentId: member.id,
      });
      models.push({ agentId: member.id, model: observation.effectiveForNewSessions });
    }
    let maintenanceHeld = false;
    try {
      await privateModelJson(path.join(host.home, '.openclaw-aws/maintenance.json'));
      maintenanceHeld = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    return {
      ...base,
      recordedPhase: 'observed',
      checkedAt: new Date().toISOString(),
      gatewayHealthy: true,
      requestedConfigurationVerified: false,
      maintenanceHeld,
      members,
      models,
    };
  }
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
    if (mode === 'abort' && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Fence a request that never acquired host maintenance. The original
      // revision/roster must still hold; missing history is not write authority.
      const current = await snapshot(host.client);
      if (
        current.hash !== action.expectedHash ||
        !isDeepStrictEqual(
          archiveMemberIdentity(parseMembers(await host.members())),
          action.existingMembers,
        )
      )
        throw new Error(
          'Unrecorded team request no longer matches its original preflight; maintenance was retained',
          { cause: error },
        );
      try {
        await privateModelJson(path.join(host.home, '.openclaw-aws/maintenance.json'));
        throw new Error(
          'Host maintenance already exists; an unrecorded request cannot release it',
          { cause: error },
        );
      } catch (maintenanceError) {
        if (
          !(maintenanceError instanceof Error) ||
          !('code' in maintenanceError) ||
          maintenanceError.code !== 'ENOENT'
        )
          throw maintenanceError;
      }
      await host.client.health();
      journal = await teamHostJournal(host.home, job, true);
    } else {
      if (
        mode === 'inspect' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )
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
  }
  const members = desiredMembers(job, host.home, action.existingMembers);
  const hasModels =
    job.definition.defaultModel !== undefined ||
    job.definition.members.some((member) => member.model !== undefined);
  const verified = async (includeModels = true) => {
    const current = await snapshot(host.client);
    const observed = archiveMemberIdentity(parseMembers(await host.members()));
    if (!isDeepStrictEqual(observed, archiveMemberIdentity(members)))
      throw new Error('Native team roster differs from its approved complete roster');
    const patch = teamConfigurationPatch({
      definition: job.definition,
      home: host.home,
      members,
      config: current.config,
      includeModels,
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
    if (includeModels && hasModels) {
      const agents = modelObject(current.config.agents);
      const entries = modelObject(agents.entries);
      const primary = (value: unknown) => {
        const setting = nativeModelSetting(value);
        return typeof setting === 'string' ? setting : setting?.primary;
      };
      const defaultPrimary = primary(modelObject(agents.defaults ?? {}).model);
      for (const member of members) {
        const expected = primary(modelObject(entries[member.id]).model) ?? defaultPrimary;
        if (!expected) continue;
        const observed = await inspectModelSelection(host.client, {
          kind: 'agent',
          agentId: member.id,
        });
        if (observed.configHash !== current.hash || observed.effectiveForNewSessions !== expected)
          throw new Error('Native Gateway has not published the requested team models');
      }
    }
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
  const settle = async () => {
    const rosterHash = await verified(false);
    if (!(await journal.read('configuration-verified')))
      await journal.mark('configuration-verified', { configHash: rosterHash });
    if (hasModels) {
      if (await journal.read('model-intent')) {
        // The only permitted continuation after an unknown model write is a
        // fresh verification of its requested state. Never send it again.
        await verified();
      } else {
        const current = await snapshot(host.client);
        const patch = teamModelPatch(job.definition);
        const alreadyConfigured = teamConfigurationMatches(current.config, patch);
        const preimage = await journal.read('model-preimage');
        if (
          !preimage ||
          (!alreadyConfigured &&
            !isDeepStrictEqual(
              preimage.models,
              teamModelProjection(current.config, job.definition),
            ))
        )
          throw new Error('Team model settings changed after approval; no model patch was sent');
        for (const choice of teamModelChoices(current.config, job.definition))
          await assertNativeModelChoice(host.client, choice.agentId, choice.model);
        if ((await snapshot(host.client)).hash !== current.hash)
          throw new Error('Native revision changed during team model validation');
        if (!alreadyConfigured) {
          const restart =
            modelObject(modelObject(current.config.gateway ?? {}).reload ?? {}).mode === 'off';
          if (restart && !action.allowRestart)
            throw new Error('Team model settings need explicit controlled restart consent');
          await journal.mark('model-intent', { configHash: current.hash });
          const response = modelObject(
            await host.client.call('config.patch', {
              baseHash: current.hash,
              raw: JSON.stringify(patch),
              response: 'summary',
            }),
          );
          if (response.ok !== true)
            throw new Error('Team model patch was not acknowledged; inspect without replay');
          await journal.mark('model-acknowledged');
          if (restart) await host.client.restart();
        }
      }
    }
    const configHash = await verified();
    await publishTeamMembership(host.home, job.target, teamIdentity(job.teamId, job.definition));
    await journal.mark('complete', { configHash });
    await journal.release();
    return report('complete', true, configHash);
  };
  if (mode === 'inspect') {
    const phase = (await journal.read('aborted'))
      ? 'aborted'
      : (await journal.read('complete'))
        ? 'complete'
        : (await journal.read('model-intent'))
          ? 'models-uncertain'
          : (await journal.read('configuration-verified'))
            ? 'roles-configured'
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
    const configured = Boolean(await journal.read('configuration-intent'));
    if ((await journal.read('model-intent')) || (configured && !hasModels))
      throw new Error(
        'Native team configuration may be in flight; inspect/resume without replay instead of aborting',
      );
    if (configured) await verified(false);
    await journal.claim();
    await journal.mark('aborted');
    await journal.release();
    return {
      ...(await report('aborted')),
      retainedInstructionFiles: true,
      retainedNativeConfiguration: configured,
    };
  }
  if (await journal.read('configuration-intent')) {
    if (mode !== 'resume')
      throw new Error(
        'Native team setup already started; resume verifies its result without another write',
      );
    if (!(await journal.ownsMaintenance()))
      throw new Error('Interrupted team setup no longer owns host maintenance');
    return settle();
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
    includeModels: false,
  });
  await journal.claim();
  await journal.mark('started');
  if (hasModels)
    await journal.mark('model-preimage', {
      models: teamModelProjection(before.config, job.definition),
    });
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
  return settle();
}
