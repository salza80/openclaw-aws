import { isDeepStrictEqual } from 'node:util';

export type ModelScope = { kind: 'default' } | { kind: 'agent'; agentId: string };
export type ModelSetting = string | { primary?: string; fallbacks?: string[] };
export interface ModelMutationRecord {
  phase: 'intent' | 'acknowledged' | 'complete' | 'rolled-back' | 'uncertain';
  scope: ModelScope;
  beforeHash: string;
  requested: string;
  previous: ModelSetting | null;
  previousPublished: string;
}
/** Host callers hold the deployment flock/maintenance record. RPC is always
 * directed at the authenticated running Gateway, never an offline CLI fallback.
 * Records contain only model settings; never persist a complete native config.
 */
export interface NativeModelClient {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  health(): Promise<void>;
  restart(): Promise<void>;
  record(value: ModelMutationRecord): Promise<void>;
}
export class ModelControlError extends Error {
  constructor(
    public readonly outcome: 'unchanged' | 'conflict' | 'rolled-back' | 'uncertain',
    message: string,
  ) {
    super(message);
    this.name = 'ModelControlError';
  }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native model control returned an unsupported structured result');
  return value as Record<string, unknown>;
};
const field = (value: unknown, key: string) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
const hasControlCharacters = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
export function nativeModelReference(value: unknown): string {
  const slash = typeof value === 'string' ? value.indexOf('/') : -1;
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    slash < 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value.slice(0, slash)) ||
    value.slice(slash + 1).trim() !== value.slice(slash + 1) ||
    slash === value.length - 1 ||
    hasControlCharacters(value)
  )
    throw new Error('Use a fully qualified native provider/model catalog key');
  return value;
}
function storedReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2048 ||
    hasControlCharacters(value)
  )
    throw new Error('Native model selection has an invalid reference');
  // Existing aliases belong to native resolution. Preserve them exactly for
  // rollback instead of interpreting them as this CLI's provider defaults.
  return value;
}
export function nativeModelScope(input: ModelScope): ModelScope {
  if (input.kind === 'default') return { kind: 'default' };
  if (
    input.kind !== 'agent' ||
    typeof input.agentId !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.agentId) ||
    ['constructor', 'prototype', '__proto__'].includes(input.agentId)
  )
    throw new Error('Use an existing native agent ID');
  return { kind: 'agent', agentId: input.agentId };
}
export function nativeModelSetting(value: unknown): ModelSetting | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return storedReference(value);
  const entry = record(value);
  if (
    Object.keys(entry).some((key) => !['primary', 'fallbacks'].includes(key)) ||
    (entry.primary !== undefined && typeof entry.primary !== 'string') ||
    (entry.fallbacks !== undefined && !Array.isArray(entry.fallbacks))
  )
    throw new Error('Native model setting has unsupported fields; no change was applied');
  if (entry.primary !== undefined) storedReference(entry.primary);
  if (entry.fallbacks !== undefined) (entry.fallbacks as unknown[]).forEach(storedReference);
  return structuredClone(entry) as Exclude<ModelSetting, string>;
}
interface Snapshot {
  hash: string;
  config: Record<string, unknown>;
}
async function snapshot(client: NativeModelClient): Promise<Snapshot> {
  const response = record(await client.call('config.get', {}));
  if (
    response.valid === false ||
    typeof response.hash !== 'string' ||
    !response.hash.trim() ||
    response.hash.length > 2048 ||
    hasControlCharacters(response.hash)
  )
    throw new Error('Running Gateway did not provide a valid revision-checked configuration');
  return { hash: response.hash, config: record(response.config) };
}
function selection(config: Record<string, unknown>, scope: ModelScope) {
  const agents = field(config, 'agents');
  return nativeModelSetting(
    field(
      scope.kind === 'default'
        ? field(agents, 'defaults')
        : field(field(agents, 'entries'), scope.agentId),
      'model',
    ),
  );
}
function patch(scope: ModelScope, value: ModelSetting | null) {
  return {
    agents:
      scope.kind === 'default'
        ? { defaults: { model: value } }
        : { entries: { [scope.agentId]: { model: value } } },
  };
}
async function assertAgent(client: NativeModelClient, scope: ModelScope) {
  const roster = record(await client.call('agents.list', {}));
  if (!Array.isArray(roster.agents) || !roster.agents.length)
    throw new Error('Running Gateway roster is unavailable');
  const ids = roster.agents.map((agent) => {
    const identity = { kind: 'agent' as const, agentId: field(agent, 'id') as string };
    nativeModelScope(identity);
    return identity.agentId;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error('Running Gateway returned duplicate agent identities');
  if (scope.kind === 'agent' && !ids.includes(scope.agentId))
    throw new Error('Requested agent is absent from the running Gateway roster');
  return ids;
}
/** sessions.list projects defaults from the Gateway's published runtime config.
 * File config and models status alone cannot certify publication with reload off.
 */
async function published(client: NativeModelClient, scope: ModelScope): Promise<string> {
  const result = record(
    await client.call('sessions.list', {
      ...(scope.kind === 'agent' ? { agentId: scope.agentId } : {}),
      limit: 1,
    }),
  );
  const defaults = record(result.defaults);
  if (typeof defaults.modelProvider !== 'string' || typeof defaults.model !== 'string')
    throw new Error('Running Gateway did not provide published model defaults');
  return nativeModelReference(`${defaults.modelProvider}/${defaults.model}`);
}
function reloadOff(config: Record<string, unknown>) {
  return field(field(field(config, 'gateway'), 'reload'), 'mode') === 'off';
}
function primary(value: ModelSetting | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.primary;
}
export interface ModelSelectionObservation {
  scope: ModelScope;
  configHash: string;
  configured: ModelSetting | null;
  effectiveForNewSessions: string;
  inherited: boolean;
  reloadOff: boolean;
  checkedAt: string;
}
export async function inspectModelSelection(
  client: NativeModelClient,
  input: ModelScope,
): Promise<ModelSelectionObservation> {
  const scope = nativeModelScope(input);
  await assertAgent(client, scope);
  const before = await snapshot(client);
  const effectiveForNewSessions = await published(client, scope);
  const after = await snapshot(client);
  if (after.hash !== before.hash)
    throw new ModelControlError(
      'conflict',
      'Native configuration changed during inspection; retry the read',
    );
  const configured = selection(before.config, scope);
  return {
    scope,
    configHash: before.hash,
    configured: configured ?? null,
    effectiveForNewSessions,
    inherited: scope.kind === 'agent' && primary(configured) === undefined,
    reloadOff: reloadOff(before.config),
    checkedAt: new Date().toISOString(),
  };
}
async function assertCatalogChoice(client: NativeModelClient, agentId: string, model: string) {
  const provider = model.split('/')[0];
  const result = record(
    await client.call('models.list', {
      agentId,
      provider,
      // The native "all" view bypasses model policy. A persistent setting must
      // remain usable by this agent, even though config.patch is an admin write.
      view: 'default',
      includeDetails: true,
    }),
  );
  if (!Array.isArray(result.models)) throw new Error('Native catalog inventory is unavailable');
  const match = result.models.find(
    (row) =>
      typeof field(row, 'provider') === 'string' &&
      typeof field(row, 'id') === 'string' &&
      `${field(row, 'provider')}/${field(row, 'id')}` === model,
  );
  if (!match)
    throw new ModelControlError(
      'unchanged',
      'Model is absent from native inventory permitted by this agent policy; review policy and provider discovery before selecting it',
    );
  if (field(match, 'available') === false) {
    const reason = field(match, 'unavailableReason');
    throw new ModelControlError(
      'unchanged',
      reason === 'missing-auth'
        ? 'Native model authentication is unavailable; configure the provider before selecting it'
        : 'Native model route is unavailable; inspect provider access and runtime compatibility',
    );
  }
  if (field(match, 'supportsTools') === false)
    throw new ModelControlError(
      'unchanged',
      'Native catalog reports unsupported tool use for this model',
    );
  if (provider === 'amazon-bedrock' && field(match, 'supportsStreaming') === false)
    throw new ModelControlError(
      'unchanged',
      'Native catalog reports unsupported response streaming for the Bedrock provider',
    );
  if (field(match, 'manualSelectionAllowed') === false)
    throw new ModelControlError(
      'unchanged',
      'Native model policy does not permit manually selecting this model',
    );
  if (Array.isArray(result.pendingProviders) && result.pendingProviders.includes(provider))
    throw new ModelControlError(
      'unchanged',
      'Native provider refresh is pending; retry after it publishes',
    );
  // Unknown capabilities/readiness remain advisory. No discovery, token refresh
  // probe or paid inference is hidden inside model selection.
}
export interface ModelSelectionChange extends ModelSelectionObservation {
  previous: ModelSetting | null;
  requested: string;
  restarted: boolean;
  sessionSelections: 'preserved';
  inferenceVerified: false;
}
/** Change one persistent native setting, preserving fallbacks, sibling fields
 * and session selections. Unacknowledged writes never trigger blind retries or
 * rollback over an unknown owner. The host journal fences reconciliation.
 */
export async function changeModelSelection(
  client: NativeModelClient,
  options: { scope: ModelScope; model: string; expectedHash: string; allowRestart?: boolean },
): Promise<ModelSelectionChange> {
  const scope = nativeModelScope(options.scope);
  const model = nativeModelReference(options.model);
  const agentIds = await assertAgent(client, scope);
  const before = await snapshot(client);
  if (before.hash !== options.expectedHash)
    throw new ModelControlError(
      'conflict',
      'Native configuration changed after the preview; no write was attempted',
    );
  const previous = selection(before.config, scope);
  const previousPublished = await published(client, scope);
  if (reloadOff(before.config) && !options.allowRestart)
    throw new ModelControlError(
      'unchanged',
      'Gateway reload is off; explicitly approve a controlled Gateway restart before changing models',
    );
  // A global write still needs explicit catalog ownership on a multi-agent
  // Gateway. Validate every agent inheriting that primary, without confusing
  // those read contexts with the persistent write scope.
  const inheritors = agentIds.filter(
    (agentId) => primary(selection(before.config, { kind: 'agent', agentId })) === undefined,
  );
  const catalogAgents =
    scope.kind === 'agent' ? [scope.agentId] : inheritors.length ? inheritors : [agentIds[0]];
  for (const agentId of catalogAgents) await assertCatalogChoice(client, agentId, model);
  const desired: ModelSetting =
    typeof previous === 'string' ? model : { ...previous, primary: model };
  const mutation = {
    scope,
    beforeHash: before.hash,
    requested: model,
    previous: previous ?? null,
    previousPublished,
  };
  await client.record({ ...mutation, phase: 'intent' });
  let acknowledged = false;
  let restarted = false;
  try {
    const ack = record(
      await client.call('config.patch', {
        baseHash: before.hash,
        raw: JSON.stringify(patch(scope, desired)),
        response: 'summary',
      }),
    );
    if (ack.ok !== true) throw new Error('Native write was not acknowledged');
    acknowledged = true;
    await client.record({ ...mutation, phase: 'acknowledged' });
    if (reloadOff(before.config)) {
      await client.restart();
      restarted = true;
    }
    await client.health();
    const result = await inspectModelSelection(client, scope);
    if (!isDeepStrictEqual(result.configured, desired))
      throw new ModelControlError(
        'conflict',
        'Another native writer changed this model selection; reconciliation is required',
      );
    if (result.effectiveForNewSessions !== model)
      throw new Error('Gateway has not published the requested persistent model');
    await client.record({ ...mutation, phase: 'complete' });
    return {
      ...result,
      previous: previous ?? null,
      requested: model,
      restarted,
      sessionSelections: 'preserved',
      inferenceVerified: false,
    };
  } catch {
    if (!acknowledged) {
      await client.record({ ...mutation, phase: 'uncertain' }).catch(() => {});
      throw new ModelControlError(
        'uncertain',
        'Native model write was not acknowledged; inspect/reconcile the recorded operation before retrying',
      );
    }
    let rolledBack = false;
    let conflict = false;
    try {
      const current = await snapshot(client);
      if (!isDeepStrictEqual(selection(current.config, scope), desired)) conflict = true;
      else {
        const ack = record(
          await client.call('config.patch', {
            baseHash: current.hash,
            raw: JSON.stringify(patch(scope, previous ?? null)),
            response: 'summary',
          }),
        );
        if (ack.ok !== true) throw new Error('Rollback was not acknowledged');
        if (reloadOff(current.config)) await client.restart();
        await client.health();
        const restored = await inspectModelSelection(client, scope);
        if (
          !isDeepStrictEqual(restored.configured, previous ?? null) ||
          restored.effectiveForNewSessions !== previousPublished
        )
          throw new Error('Rollback publication was not confirmed');
        await client.record({ ...mutation, phase: 'rolled-back' });
        rolledBack = true;
      }
    } catch {
      /* Retain maintenance ownership for explicit reconciliation. */
    }
    if (rolledBack)
      throw new ModelControlError(
        'rolled-back',
        'Model change failed; the previous persistent selection and published defaults were restored',
      );
    await client.record({ ...mutation, phase: 'uncertain' }).catch(() => {});
    throw new ModelControlError(
      conflict ? 'conflict' : 'uncertain',
      conflict
        ? 'Another native writer changed the model; automatic rollback was refused to preserve their selection'
        : 'Model change failed and rollback could not be confirmed; inspect/reconcile before further mutations',
    );
  }
}
