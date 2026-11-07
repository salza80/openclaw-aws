import { object } from './backup-contract.js';

/** Nonsecret native policy only. Provider/tool implementation configuration is
 * deliberately outside this projection, including executable/environment data. */
export interface NativeToolPolicy {
  profile?: 'minimal' | 'coding' | 'messaging' | 'full';
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
}
export interface NativeModelPolicy {
  allow?: string[];
}
export function nativeModelPolicy(value: unknown): NativeModelPolicy {
  const row = object(value);
  return row.allow === undefined ? {} : { allow: nativePolicyStrings(row.allow) };
}
export interface NativeAgentToolPolicy extends NativeToolPolicy {
  agentToAgent?: { send?: string[] };
}
export interface NativeDelegationPolicy {
  allowAgents?: string[];
  delegationMode?: 'suggest' | 'prefer';
  requireAgentId?: boolean;
}
export interface NativeDelegationDefaults extends NativeDelegationPolicy {
  maxConcurrent?: number;
  maxChildrenPerAgent?: number;
  maxSpawnDepth?: number;
}
export function nativePolicyStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('Native policy list exceeds its supported bound');
  return value.map((item) => {
    if (
      typeof item !== 'string' ||
      item.length > 256 ||
      [...item].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error('Native policy requires bounded strings');
    return item;
  });
}
export function nativeToolPolicy(value: unknown): NativeToolPolicy {
  const row = object(value);
  const result: NativeToolPolicy = {};
  if (row.profile !== undefined) {
    if (!['minimal', 'coding', 'messaging', 'full'].includes(String(row.profile)))
      throw new Error('A custom tool profile needs an explicit supported mapping');
    result.profile = row.profile as NativeToolPolicy['profile'];
  }
  for (const key of ['allow', 'alsoAllow', 'deny'] as const)
    if (row[key] !== undefined) result[key] = nativePolicyStrings(row[key]);
  return result;
}
export function nativeAgentToolPolicy(value: unknown): NativeAgentToolPolicy {
  const row = object(value);
  const result: NativeAgentToolPolicy = nativeToolPolicy(value);
  if (row.agentToAgent !== undefined) {
    const communication = object(row.agentToAgent);
    result.agentToAgent = {
      ...(communication.send !== undefined
        ? { send: nativePolicyStrings(communication.send) }
        : {}),
    };
  }
  return result;
}
export function nativeDelegationPolicy(value: unknown): NativeDelegationPolicy {
  const row = object(value);
  const result: NativeDelegationPolicy = {};
  if (row.allowAgents !== undefined) result.allowAgents = nativePolicyStrings(row.allowAgents);
  if (row.delegationMode !== undefined) {
    if (!['suggest', 'prefer'].includes(String(row.delegationMode)))
      throw new Error('Unsupported native delegation mode');
    result.delegationMode = row.delegationMode as NativeDelegationPolicy['delegationMode'];
  }
  if (row.requireAgentId !== undefined) {
    if (typeof row.requireAgentId !== 'boolean')
      throw new Error('Native delegation requires a boolean explicit-target policy');
    result.requireAgentId = row.requireAgentId;
  }
  return result;
}
export function nativeDelegationDefaults(value: unknown): NativeDelegationDefaults {
  const row = object(value);
  const result: NativeDelegationDefaults = nativeDelegationPolicy(value);
  for (const [key, maximum] of [
    ['maxConcurrent', 128],
    ['maxChildrenPerAgent', 128],
    ['maxSpawnDepth', 5],
  ] as const) {
    if (row[key] === undefined) continue;
    if (
      !Number.isSafeInteger(row[key]) ||
      (row[key] as number) < 1 ||
      (row[key] as number) > maximum
    )
      throw new Error('Unsupported native delegation concurrency/depth');
    result[key] = row[key] as number;
  }
  return result;
}
