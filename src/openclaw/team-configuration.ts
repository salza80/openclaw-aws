import { isDeepStrictEqual } from 'node:util';
import {
  object,
  archiveMemberIdentity,
  parseMembers,
  type BackupMember,
} from './backup-contract.js';
import {
  parseTeamDefinition,
  teamNativeId,
  teamMembers,
  type TeamDefinition,
} from './team-definition.js';

type ConfigSdk = typeof import('openclaw/plugin-sdk/config-mutation');
type NativeConfig = NonNullable<Parameters<ConfigSdk['replaceConfigFile']>[0]['sourceConfig']>;

/** Authored native settings only. The host caller owns the deployment lock,
 * private identity boundary and revision-bound mutation. No provider routing,
 * scheduler, auth store or backup format is implemented here. */
export function teamConfigurationPatch(options: {
  definition: TeamDefinition;
  home: string;
  members: BackupMember[];
  /** Exact preflight roster. New declared entries may be added atomically by
   * the native revision-bound patch without separate agents.create writes. */
  existingMembers?: BackupMember[];
  config: unknown;
}): Pick<NativeConfig, 'agents' | 'tools' | 'bindings'> {
  const definition = parseTeamDefinition(options.definition);
  const members = parseMembers(options.members);
  const main = members.find((member) => member.id === 'main');
  if (
    !main ||
    !isDeepStrictEqual(
      archiveMemberIdentity(members),
      archiveMemberIdentity(teamMembers(definition, options.home, main)),
    )
  )
    throw new Error(
      'Team configuration requires the complete declared native roster and separate owned roots',
    );
  const config = object(options.config);
  const entries = object(object(config.agents).entries);
  const existing = parseMembers(options.existingMembers ?? members);
  if (
    !existing.some((member) => member.id === 'main') ||
    Object.keys(entries).length !== existing.length ||
    existing.some(
      (member) =>
        !Object.hasOwn(entries, member.id) ||
        !members.some(
          (desired) =>
            desired.id === member.id &&
            desired.workspace === member.workspace &&
            desired.agentDir === member.agentDir,
        ),
    )
  )
    throw new Error('Team configuration would change unrelated co-hosted agents');
  const nativeEntries: NonNullable<NonNullable<NativeConfig['agents']>['entries']> = {};
  for (const member of definition.members) {
    const id = teamNativeId(definition, member.id);
    const roots = members.find((value) => value.id === id)!;
    const observed = entries[id] === undefined ? {} : object(entries[id]);
    if (
      (observed.workspace !== undefined && observed.workspace !== roots.workspace) ||
      (observed.agentDir !== undefined && observed.agentDir !== roots.agentDir)
    )
      throw new Error('Native team paths changed; no settings patch was prepared');
    nativeEntries[id] = {
      name: member.role,
      workspace: roots.workspace,
      agentDir: roots.agentDir,
      ...(member.model !== undefined ? { model: structuredClone(member.model) } : {}),
      tools: {
        ...(member.tools ?? { profile: 'messaging', alsoAllow: ['sessions_spawn', 'agents_list'] }),
        agentToAgent: { send: member.sendTo.map((target) => teamNativeId(definition, target)) },
      },
      subagents: {
        allowAgents: member.delegateTo.map((target) => teamNativeId(definition, target)),
        requireAgentId: true,
      },
    };
  }
  return {
    agents: {
      ownership: 'explicit',
      defaults: {
        systemAgent: { agentId: 'main' },
        maxConcurrent: definition.maxConcurrent,
        ...(definition.defaultModel !== undefined
          ? { model: structuredClone(definition.defaultModel) }
          : {}),
        subagents: {
          maxConcurrent: definition.maxConcurrent,
          maxChildrenPerAgent: definition.maxConcurrent,
          maxSpawnDepth: definition.maxSpawnDepth,
          requireAgentId: true,
        },
      },
      entries: nativeEntries,
    },
    tools: {
      agentToAgent: { enabled: true, allow: members.map((member) => member.id).sort() },
      sessions: { visibility: 'self' },
    },
    bindings: definition.bindings.map((binding) => ({
      ...binding,
      agentId: teamNativeId(definition, binding.agentId),
    })),
  };
}

export function teamInstructions(input: TeamDefinition, logicalId: string): string {
  const definition = parseTeamDefinition(input);
  const member = definition.members.find((value) => value.id === logicalId);
  if (!member) throw new Error('No declared role owns these team instructions');
  const describe = (ids: string[]) =>
    ids.map((id) => `${id} (native agentId: ${teamNativeId(definition, id)})`).join(', ') || 'none';
  return `# ${member.role}\n\n${member.instructions}\n\n## Team handoffs\n\nYour logical role is ${member.id}; your native agent ID is ${teamNativeId(definition, member.id)}.\nSend work with native sessions_send to: ${describe(member.sendTo)}.\nDelegate with native sessions_spawn to: ${describe(member.delegateTo)}.\nUse the native tool discovery/dispatch interface when tools are deferred. Collect actual peer replies before presenting a combined result.\n\nEach agent has a separate writable workspace. Share findings through native session tools; do not assume shared files or OS/IAM isolation.\n`;
}
/** Match only approved settings, preserving unrelated native/provider fields. */
export function teamConfigurationMatches(config: unknown, patch: unknown): boolean {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    return isDeepStrictEqual(config, patch);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const row = config as Record<string, unknown>;
  return Object.entries(patch).every(([key, value]) => teamConfigurationMatches(row[key], value));
}
