import { randomUUID } from 'node:crypto';
import { rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateProjectName } from '../cli/utils/validation.js';
import { getConfigRoot } from '../cli/utils/config.js';
import { modelObject, parseModelHostTarget } from '../openclaw/model-contract.js';
import { parseTeamDefinition } from '../openclaw/team-definition.js';
import { teamId } from '../openclaw/team-contract.js';
import { privateModelJson, createPrivateControlRecord } from '../openclaw/model-journal.js';
import { writeControlRecord } from './control-fence.js';
import type { TeamJob } from '../openclaw/team-contract.js';
import type { ModelHostTarget } from '../openclaw/model-contract.js';
import { parseTeamIdentity, type TeamIdentity } from '../openclaw/team-recovery.js';

const filename = (name: string) => {
  if (validateProjectName(name) !== true) throw new Error('Invalid team deployment name');
  return path.join(getConfigRoot(), 'teams', `${name}.json`);
};
export async function readTeamState(name: string) {
  const row = await privateModelJson(filename(name));
  if (
    row.schemaVersion !== 1 ||
    Object.keys(row).some(
      (key) => !['schemaVersion', 'teamId', 'operationId', 'target', 'definition'].includes(key),
    )
  )
    throw new Error('Invalid local team ownership metadata');
  const target = parseModelHostTarget(row.target);
  if (target.deploymentName !== name) throw new Error('Local team belongs to another deployment');
  return {
    schemaVersion: 1 as const,
    teamId: teamId(row.teamId),
    operationId: teamId(row.operationId),
    target,
    definition: parseTeamDefinition(row.definition),
  };
}
export async function saveTeamState(
  job: Pick<TeamJob, 'target' | 'teamId' | 'operationId' | 'definition'>,
  options: { rebindVerifiedTarget?: boolean } = {},
) {
  const name = job.target.deploymentName;
  const state = {
    schemaVersion: 1,
    teamId: job.teamId,
    operationId: job.operationId,
    target: job.target,
    definition: job.definition,
  };
  try {
    await writeControlRecord(filename(name), state);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const previous = await readTeamState(name);
  if (previous.teamId !== state.teamId || !isDeepStrictEqual(previous.target, state.target)) {
    if (!options.rebindVerifiedTarget || previous.operationId === state.operationId)
      throw new Error('Local team metadata belongs to another hosting identity');
    // A deliberately created/restored/independently cloned target may reuse a
    // local name after source config removal. Preserve its previous metadata.
    await writeControlRecord(
      path.join(getConfigRoot(), 'team-history', name, previous.operationId + '.json'),
      previous,
      true,
    );
  }
  // Same host lock serializes all writers of this pointer. Immutable operation
  // plans remain the recovery authority for interrupted native writes.
  const temporary = `${filename(name)}.${randomUUID()}.tmp`;
  try {
    await createPrivateControlRecord(temporary, state);
    await rename(temporary, filename(name));
    const directory = await open(path.dirname(filename(name)), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (modelObject(error).code !== 'ENOENT') throw error;
    });
  }
}
/** Caller holds the host operations lock. Recovered role metadata is for
 * reads/layout only; subsequent configure must supply an explicit new file. */
export async function saveTeamIdentityState(
  target: ModelHostTarget,
  operationId: string,
  input: TeamIdentity,
) {
  const identity = parseTeamIdentity(input);
  const definition = parseTeamDefinition({
    schemaVersion: 1,
    topology: 'single-host',
    coordinator: identity.coordinator,
    members: identity.roles.map((role) => ({
      id: role.logicalId,
      role: role.role,
      instructions: 'Recovered native role instructions remain authoritative.',
    })),
  });
  return saveTeamState(
    { teamId: identity.id, operationId, target, definition },
    { rebindVerifiedTarget: true },
  );
}
