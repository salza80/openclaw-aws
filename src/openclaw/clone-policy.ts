import path from 'node:path';
import type { BackupMember } from './backup-contract.js';
import { object } from './backup-contract.js';
import { selectedBedrockModels } from './bedrock-recovery-intent.js';
import {
  nativeToolPolicy,
  nativeAgentToolPolicy,
  nativeDelegationPolicy,
  nativeDelegationDefaults,
  nativeModelPolicy,
  type NativeModelPolicy,
  type NativeToolPolicy,
  type NativeAgentToolPolicy,
  type NativeDelegationPolicy,
  type NativeDelegationDefaults,
} from './agent-policy.js';

/** Independent copies keep selected policy, not the source's conversations or
 * historical IAM grants. Resolve the same current-schema aliases as recovery. */
export function cloneBedrockModels(
  policy: CloneSourcePolicy,
  members: { id: string; model?: string }[],
) {
  return selectedBedrockModels({
    config: {
      agents: {
        defaults: { model: policy.model, models: policy.models },
        entries: Object.fromEntries(policy.agents.map((agent) => [agent.id, agent])),
      },
    },
    members,
  });
}

export interface CloneModelSelection {
  primary?: string;
  fallbacks?: string[];
}
export type CloneToolPolicy = NativeToolPolicy;
export interface CloneModelSettings {
  alias?: string;
  agentRuntime?: { id: 'auto' | 'openclaw' };
}
export interface CloneAgentPolicy {
  id: string;
  name?: string;
  identity?: { name?: string; theme?: string; emoji?: string };
  model?: CloneModelSelection;
  models?: Record<string, CloneModelSettings>;
  modelPolicy?: NativeModelPolicy;
  skills?: string[];
  tools?: NativeAgentToolPolicy;
  subagents?: NativeDelegationPolicy;
}
export interface CloneSourcePolicy {
  schemaVersion: 1;
  systemAgent?: string;
  maxConcurrent?: number;
  model?: CloneModelSelection;
  subagents?: NativeDelegationDefaults;
  models?: Record<string, CloneModelSettings>;
  modelPolicy?: NativeModelPolicy;
  tools?: CloneToolPolicy;
  agentToAgent?: { enabled?: boolean; allow?: string[] };
  sessionVisibility?: 'self' | 'tree' | 'agent' | 'all';
  agents: CloneAgentPolicy[];
  credentialPaths: string[];
  omissions: string[];
}
const record = (value: unknown) => (value === undefined ? {} : object(value));
const text = (value: unknown, maximum = 256): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0'))
    throw new Error('A source clone setting is not a supported bounded string');
  return value;
};
const strings = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('Unsupported source clone policy list');
  return value.map((item) => text(item) ?? '');
};
function model(value: unknown): CloneModelSelection | undefined {
  if (value === undefined) return undefined;
  const source = typeof value === 'string' ? { primary: value } : object(value);
  const primary = text(source.primary);
  const fallbacks = strings(source.fallbacks);
  if (
    (primary !== undefined && !primary) ||
    [...(primary ? [primary] : []), ...(fallbacks ?? [])].some(
      (ref) => !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(ref),
    )
  )
    throw new Error('Source model references require an explicit supported clone model selection');
  return { ...(primary ? { primary } : {}), ...(fallbacks ? { fallbacks } : {}) };
}
function tools(value: unknown): CloneToolPolicy | undefined {
  if (value === undefined) return undefined;
  return nativeToolPolicy(value);
}

function selectedModels(value: unknown): Record<string, CloneModelSettings> {
  const models: Record<string, CloneModelSettings> = Object.create(null);
  for (const [reference, settings] of Object.entries(record(value))) {
    const entry = record(settings);
    const alias = text(entry.alias, 128);
    const runtime = text(record(entry.agentRuntime).id);
    if (runtime !== undefined && runtime !== 'auto' && runtime !== 'openclaw')
      throw new Error('A source model runtime requires an explicitly supported clone mapping');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(reference))
      throw new Error('Unsupported source model alias reference');
    // Even an empty model entry participates in native model restrictions.
    models[reference] = {
      ...(alias ? { alias } : {}),
      ...(runtime ? { agentRuntime: { id: runtime } } : {}),
    };
  }
  return models;
}

/** Read a strict non-secret policy allowlist from the native source snapshot.
 * Never return provider/auth/plugin/MCP configuration or arbitrary tool options.
 */
export function clonePolicyFromConfig(value: unknown, members: BackupMember[]): CloneSourcePolicy {
  const source = object(value);
  const agents = record(source.agents);
  const defaults = record(agents.defaults);
  const entries = record(agents.entries);
  const ids = new Set(members.map((member) => member.id));
  const implicitMain =
    Object.keys(entries).length === 0 && members.length === 1 && members[0].id === 'main';
  if (
    ids.size !== members.length ||
    ids.size === 0 ||
    Object.keys(entries).some((id) => !ids.has(id)) ||
    (!implicitMain && members.some((member) => !Object.hasOwn(entries, member.id)))
  )
    throw new Error('Source policy roster differs from the completed backup');
  const owner = text(record(defaults.systemAgent).agentId);
  if (owner && !ids.has(owner)) throw new Error('Source system owner is outside the copied roster');
  const maxConcurrent = defaults.maxConcurrent;
  if (
    maxConcurrent !== undefined &&
    (!Number.isSafeInteger(maxConcurrent) ||
      (maxConcurrent as number) < 1 ||
      (maxConcurrent as number) > 128)
  )
    throw new Error('Unsupported source global agent concurrency');
  const sharedTools = record(source.tools);
  const communication = record(sharedTools.agentToAgent);
  const visibility = record(sharedTools.sessions).visibility;
  if (visibility !== undefined && !['self', 'tree', 'agent', 'all'].includes(String(visibility)))
    throw new Error('Unsupported source session visibility policy');
  if (communication.enabled !== undefined && typeof communication.enabled !== 'boolean')
    throw new Error('Unsupported source agent communication policy');
  const models = selectedModels(defaults.models);
  const policies = members.map((member) => {
    const settings = record(entries[member.id]);
    const identity = record(settings.identity);
    const identityFields: NonNullable<CloneAgentPolicy['identity']> = {};
    for (const key of ['name', 'theme', 'emoji'] as const) {
      const field = text(identity[key]);
      if (field !== undefined) identityFields[key] = field;
    }
    return {
      id: member.id,
      ...(settings.name !== undefined ? { name: text(settings.name) } : {}),
      ...(Object.keys(identityFields).length ? { identity: identityFields } : {}),
      ...(settings.model !== undefined ? { model: model(settings.model) } : {}),
      ...(settings.models !== undefined ? { models: selectedModels(settings.models) } : {}),
      ...(settings.modelPolicy !== undefined
        ? { modelPolicy: nativeModelPolicy(settings.modelPolicy) }
        : {}),
      ...(settings.skills !== undefined ? { skills: strings(settings.skills) } : {}),
      ...(settings.tools !== undefined ? { tools: nativeAgentToolPolicy(settings.tools) } : {}),
      ...(settings.subagents !== undefined
        ? { subagents: nativeDelegationPolicy(settings.subagents) }
        : {}),
    };
  });
  const credentialPaths = new Set<string>();
  for (const provider of Object.values(record(record(source.secrets).providers))) {
    const settings = object(provider);
    if (settings.source !== 'file') continue;
    const filename = text(settings.path, 4096);
    if (
      !filename ||
      filename.includes('${') ||
      (!path.posix.isAbsolute(filename) && !filename.startsWith('~/'))
    )
      throw new Error('A source file credential has no supported static absolute path');
    credentialPaths.add(
      path.posix.resolve('/home/ubuntu', filename.startsWith('~/') ? filename.slice(2) : filename),
    );
  }
  return {
    schemaVersion: 1,
    ...(owner ? { systemAgent: owner } : {}),
    ...(maxConcurrent === undefined ? {} : { maxConcurrent: maxConcurrent as number }),
    ...(defaults.model !== undefined ? { model: model(defaults.model) } : {}),
    ...(defaults.subagents !== undefined
      ? { subagents: nativeDelegationDefaults(defaults.subagents) }
      : {}),
    ...(defaults.models !== undefined ? { models } : {}),
    ...(defaults.modelPolicy !== undefined
      ? { modelPolicy: nativeModelPolicy(defaults.modelPolicy) }
      : {}),
    ...(source.tools !== undefined ? { tools: tools(source.tools) } : {}),
    ...(sharedTools.agentToAgent !== undefined
      ? {
          agentToAgent: {
            ...(communication.enabled !== undefined
              ? { enabled: communication.enabled as boolean }
              : {}),
            ...(communication.allow !== undefined ? { allow: strings(communication.allow) } : {}),
          },
        }
      : {}),
    ...(visibility !== undefined
      ? { sessionVisibility: visibility as CloneSourcePolicy['sessionVisibility'] }
      : {}),
    agents: policies,
    credentialPaths: [...credentialPaths].sort(),
    omissions: [
      'Messaging/device/OAuth credentials, sessions, approvals and delivery state are excluded.',
      'Native auth/session store sharing is reset; cloned roles use fresh native stores and explicitly supplied provider credentials.',
      'Source provider secrets, custom provider endpoints, plugins, MCP/database connections and external path settings are not activated.',
      'Cron, heartbeats, hooks, semantic indexing and bootstrap execution remain disabled until reviewed.',
      'Opaque personal skill-library/plugin ownership requires supported native export/import; it is not copied as identity.',
    ],
  };
}
