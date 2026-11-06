import { createHash } from 'node:crypto';
import { archiveMemberIdentity, parseMembers, type ArchiveMember } from './backup-contract.js';
import {
  modelObject,
  modelText,
  parseModelHostTarget,
  parseModelRuntime,
  type ModelHostTarget,
  type ModelJob,
} from './model-contract.js';
import { parseTeamDefinition, teamNativeId, type TeamDefinition } from './team-definition.js';

export interface TeamInstructionPin {
  agentId: string;
  sha256: string | null;
}
export interface TeamPreflight {
  expectedHash: string;
  existingMembers: ArchiveMember[];
  instructions: TeamInstructionPin[];
  reloadOff: boolean;
}
export interface TeamJob {
  schemaVersion: 1;
  kind: 'native-team';
  operationId: string;
  teamId: string;
  target: ModelHostTarget;
  runtime: ModelJob['runtime'];
  definition: TeamDefinition;
  bedrockRole: boolean;
  action: { kind: 'preview' } | ({ kind: 'configure'; allowRestart: boolean } & TeamPreflight);
}
export type TeamWorkerMode = 'execute' | 'inspect' | 'resume' | 'abort';
export function teamId(value: unknown) {
  const id = modelText(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new Error('Team identity and operation require UUIDs');
  return id;
}
function exact(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error('Unsupported native team control fields');
}
export function parseTeamPreflight(value: unknown, definition: TeamDefinition): TeamPreflight {
  const row = modelObject(value);
  const existingMembers = archiveMemberIdentity(parseMembers(row.existingMembers));
  const ids = definition.members.map((member) => teamNativeId(definition, member.id));
  if (
    !existingMembers.some((member) => member.id === 'main') ||
    existingMembers.some((member) => !ids.includes(member.id)) ||
    typeof row.reloadOff !== 'boolean' ||
    !Array.isArray(row.instructions) ||
    row.instructions.length !== ids.length
  )
    throw new Error('Team preflight does not cover the complete intended roster');
  const instructions = row.instructions
    .map((value): TeamInstructionPin => {
      const pin = modelObject(value);
      exact(pin, ['agentId', 'sha256']);
      const agentId = modelText(pin.agentId, 64);
      if (
        !ids.includes(agentId) ||
        (pin.sha256 !== null &&
          (typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256)))
      )
        throw new Error('Team instruction ownership pin is invalid');
      return { agentId, sha256: pin.sha256 as string | null };
    })
    .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  if (new Set(instructions.map((pin) => pin.agentId)).size !== ids.length)
    throw new Error('Team instruction pins repeat a member');
  return {
    expectedHash: modelText(row.expectedHash),
    existingMembers,
    instructions,
    reloadOff: row.reloadOff,
  };
}
export function parseTeamJob(input: unknown): TeamJob {
  const row = modelObject(input);
  exact(row, [
    'schemaVersion',
    'kind',
    'operationId',
    'teamId',
    'target',
    'runtime',
    'definition',
    'bedrockRole',
    'action',
  ]);
  if (row.schemaVersion !== 1 || row.kind !== 'native-team' || typeof row.bedrockRole !== 'boolean')
    throw new Error('Unsupported native team request');
  const definition = parseTeamDefinition(row.definition);
  const action = modelObject(row.action);
  let parsed: TeamJob['action'];
  if (action.kind === 'preview') {
    exact(action, ['kind']);
    parsed = { kind: 'preview' };
  } else if (action.kind === 'configure') {
    exact(action, [
      'kind',
      'allowRestart',
      'expectedHash',
      'existingMembers',
      'instructions',
      'reloadOff',
    ]);
    if (typeof action.allowRestart !== 'boolean')
      throw new Error('Team setup needs explicit restart consent');
    parsed = {
      kind: 'configure',
      allowRestart: action.allowRestart,
      ...parseTeamPreflight(action, definition),
    };
  } else throw new Error('Unsupported native team action');
  return {
    schemaVersion: 1,
    kind: 'native-team',
    operationId: teamId(row.operationId),
    teamId: teamId(row.teamId),
    target: parseModelHostTarget(row.target),
    runtime: parseModelRuntime(row.runtime),
    definition,
    bedrockRole: row.bedrockRole,
    action: parsed,
  };
}
export function teamJobDigest(input: TeamJob) {
  return createHash('sha256')
    .update(JSON.stringify(parseTeamJob(input)))
    .digest('hex');
}
