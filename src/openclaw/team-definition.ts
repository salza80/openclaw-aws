import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ApiKeyProvider } from '../cli/types/index.js';
import { isApiKeyProvider } from './connections.js';
import {
  object,
  textField,
  parseMembers,
  archiveMemberIdentity,
  type BackupMember,
} from './backup-contract.js';
import {
  nativeModelReference,
  nativeModelScope,
  nativeModelSetting,
  type ModelSetting,
} from './model-control.js';
import { nativeToolPolicy, type NativeToolPolicy } from './agent-policy.js';
import { modelText } from './model-contract.js';

export interface TeamMember {
  id: string;
  role: string;
  instructions: string;
  model?: ModelSetting;
  tools?: NativeToolPolicy;
  sendTo: string[];
  delegateTo: string[];
}
export interface TeamBinding {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    guildId?: string;
    teamId?: string;
    peer?: { kind: 'direct' | 'group' | 'channel'; id: string };
  };
}
export interface TeamCredentialReference {
  provider: ApiKeyProvider;
  kind: 'env' | 'ssm';
  reference: string;
}
export interface TeamDefinition {
  schemaVersion: 1;
  topology: 'single-host';
  coordinator: string;
  maxConcurrent: number;
  maxSpawnDepth: number;
  defaultModel?: ModelSetting;
  members: TeamMember[];
  bindings: TeamBinding[];
  credentials: TeamCredentialReference[];
}
function exact(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error(
      'Team definition contains unsupported fields; use credential references, not keys',
    );
}
function agentId(value: unknown) {
  const id = textField(value, 64);
  nativeModelScope({ kind: 'agent', agentId: id });
  return id;
}
function selection(value: unknown): ModelSetting {
  const setting = nativeModelSetting(value);
  if (!setting) throw new Error('Team model selection is empty');
  for (const ref of typeof setting === 'string'
    ? [setting]
    : [setting.primary, ...(setting.fallbacks ?? [])])
    if (ref !== undefined) nativeModelReference(ref);
  return setting;
}
function integer(value: unknown, fallback: number, maximum: number) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(actual) || (actual as number) < 1 || (actual as number) > maximum)
    throw new Error('Team concurrency/depth exceeds the supported native bound');
  return actual as number;
}
function targets(value: unknown, defaults: string[], ids: Set<string>) {
  if (value === undefined) return defaults;
  if (!Array.isArray(value) || value.length > ids.size)
    throw new Error('Team communication targets require a bounded explicit member list');
  const result = value.map(agentId);
  if (new Set(result).size !== result.length || result.some((id) => !ids.has(id)))
    throw new Error('Team communication target is duplicated or outside the team');
  return result;
}
export function parseTeamDefinition(value: unknown): TeamDefinition {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 8000)
    throw new Error('Team definition exceeds the 8,000-byte control request budget');
  const row = object(value);
  exact(row, [
    'schemaVersion',
    'topology',
    'coordinator',
    'maxConcurrent',
    'maxSpawnDepth',
    'defaultModel',
    'members',
    'bindings',
    'credentials',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.topology !== 'single-host' ||
    !Array.isArray(row.members) ||
    row.members.length < 2 ||
    row.members.length > 16
  )
    throw new Error('A team requires schemaVersion 1, single-host topology and 2–16 members');
  const coordinator = agentId(row.coordinator);
  const ids = new Set(row.members.map((member) => agentId(object(member).id)));
  if (
    ids.size !== row.members.length ||
    !ids.has(coordinator) ||
    (ids.has('main') && coordinator !== 'main')
  )
    throw new Error(
      'Team IDs must be unique, include the coordinator and reserve native main for it',
    );
  const members = row.members.map((value): TeamMember => {
    const member = object(value);
    exact(member, ['id', 'role', 'instructions', 'model', 'tools', 'sendTo', 'delegateTo']);
    const id = agentId(member.id);
    const instructions = member.instructions;
    if (
      typeof instructions !== 'string' ||
      !instructions.trim() ||
      instructions.length > 3000 ||
      [...instructions].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      })
    )
      throw new Error('Team instructions require bounded Markdown without control characters');
    if (member.tools !== undefined) {
      const tools = object(member.tools);
      exact(tools, ['profile', 'allow', 'alsoAllow', 'deny']);
    }
    return {
      id,
      role: modelText(member.role, 128),
      instructions,
      ...(member.model !== undefined ? { model: selection(member.model) } : {}),
      ...(member.tools !== undefined ? { tools: nativeToolPolicy(member.tools) } : {}),
      sendTo: targets(
        member.sendTo,
        id === coordinator ? [...ids].filter((other) => other !== id) : [coordinator],
        ids,
      ),
      delegateTo: targets(
        member.delegateTo,
        id === coordinator ? [...ids].filter((other) => other !== id) : [],
        ids,
      ),
    };
  });
  if (row.bindings !== undefined && (!Array.isArray(row.bindings) || row.bindings.length > 32))
    throw new Error('Team routing bindings exceed the supported bound');
  const bindings = ((row.bindings ?? []) as unknown[]).map((value): TeamBinding => {
    const binding = object(value),
      match = object(binding.match);
    exact(binding, ['agentId', 'match']);
    exact(match, ['channel', 'accountId', 'guildId', 'teamId', 'peer']);
    const id = agentId(binding.agentId);
    if (!ids.has(id)) throw new Error('Team binding belongs to an unrelated member');
    const output: TeamBinding = { agentId: id, match: { channel: modelText(match.channel, 128) } };
    for (const key of ['accountId', 'guildId', 'teamId'] as const)
      if (match[key] !== undefined) output.match[key] = modelText(match[key], 256);
    if (match.peer !== undefined) {
      const peer = object(match.peer);
      exact(peer, ['kind', 'id']);
      if (!['direct', 'group', 'channel'].includes(String(peer.kind)))
        throw new Error('Team binding has unsupported peer routing');
      output.match.peer = {
        kind: peer.kind as 'direct' | 'group' | 'channel',
        id: modelText(peer.id, 256),
      };
    }
    return output;
  });
  if (
    row.credentials !== undefined &&
    (!Array.isArray(row.credentials) || row.credentials.length > 16)
  )
    throw new Error('Team credential references exceed the supported bound');
  const credentials = ((row.credentials ?? []) as unknown[]).map(
    (value): TeamCredentialReference => {
      const entry = object(value);
      exact(entry, ['provider', 'kind', 'reference']);
      const reference = textField(entry.reference, 1024);
      if (
        !isApiKeyProvider(entry.provider) ||
        !['env', 'ssm'].includes(String(entry.kind)) ||
        !(entry.kind === 'env'
          ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)
          : /^\/[A-Za-z0-9_./-]+(?::[1-9][0-9]*)?$/.test(reference))
      )
        throw new Error('Team credentials must reference an environment variable or SSM parameter');
      return { provider: entry.provider, kind: entry.kind as 'env' | 'ssm', reference };
    },
  );
  if (new Set(credentials.map((entry) => entry.provider)).size !== credentials.length)
    throw new Error('Select one explicit team credential reference per provider');
  const result: TeamDefinition = {
    schemaVersion: 1,
    topology: 'single-host',
    coordinator,
    maxConcurrent: integer(row.maxConcurrent, 3, 16),
    maxSpawnDepth: integer(row.maxSpawnDepth, 2, 5),
    ...(row.defaultModel !== undefined ? { defaultModel: selection(row.defaultModel) } : {}),
    members,
    bindings,
    credentials,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 8000)
    throw new Error('Expanded team definition exceeds the 8,000-byte control request budget');
  return result;
}
export function teamDefinitionDigest(input: TeamDefinition) {
  return createHash('sha256')
    .update(JSON.stringify(parseTeamDefinition(input)))
    .digest('hex');
}
export const teamNativeId = (definition: TeamDefinition, logicalId: string) => {
  if (!definition.members.some((member) => member.id === logicalId))
    throw new Error('Team member is outside the declared roster');
  return logicalId === definition.coordinator ? 'main' : logicalId;
};
export function teamMembers(
  definition: TeamDefinition,
  home: string,
  main: BackupMember,
): BackupMember[] {
  if (!path.isAbsolute(home) || path.resolve(home) !== home || home === '/' || main.id !== 'main')
    throw new Error('Team layout requires a canonical native home and its existing main agent');
  const root = path.join(home, '.openclaw');
  if (
    ![path.join(root, 'workspace'), path.join(root, 'workspaces/main')].includes(main.workspace) ||
    main.agentDir !== path.join(root, 'agents/main/agent')
  )
    throw new Error(
      'Team coordinator must use this fresh installation’s owned default native roots',
    );
  return definition.members.map((member) => {
    const id = teamNativeId(definition, member.id);
    return id === 'main'
      ? { ...main }
      : {
          id,
          workspace: path.join(root, 'workspaces', id),
          agentDir: path.join(root, 'agents', id, 'agent'),
        };
  });
}
export function assertTeamLayout(definition: TeamDefinition, home: string, input: BackupMember[]) {
  const members = parseMembers(input);
  const main = members.find((member) => member.id === 'main');
  if (
    !main ||
    !isDeepStrictEqual(
      archiveMemberIdentity(members),
      archiveMemberIdentity(teamMembers(parseTeamDefinition(definition), home, main)),
    )
  )
    throw new Error(
      'Team configuration requires the complete declared native roster and separate owned roots',
    );
  return members;
}
