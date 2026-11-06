import { isDeepStrictEqual } from 'node:util';
import { nativeModelReference, nativeModelScope } from './model-control.js';
import { modelObject, modelText, parseModelJob, type ModelJob } from './model-contract.js';
import type { ModelWorkerMode } from './model-worker.js';

export interface ModelResult extends Record<string, unknown> {
  ok: true;
  schemaVersion: 1;
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: string;
}
const header = ['ok', 'schemaVersion', 'operationId', 'stackId', 'instanceId', 'phase'];
const summary = [
  'scope',
  'configHash',
  'configuredPrimary',
  'fallbackCount',
  'effectiveForNewSessions',
  'inherited',
  'reloadOff',
  'checkedAt',
  'sessionSelections',
  'inferenceVerified',
];
function exact(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error('Unexpected private/unsupported model result fields');
}
function count(value: unknown, max = 100000) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new Error('Invalid bounded model result count');
}
function bool(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Invalid model result flag');
}
function timestamp(value: unknown) {
  const text = modelText(value, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error('Invalid model result timestamp');
}
function scope(row: Record<string, unknown>, job: ModelJob) {
  const input = modelObject(row.scope);
  exact(input, input.kind === 'default' ? ['kind'] : ['kind', 'agentId']);
  const selected = nativeModelScope(input as unknown as ModelJob['scope']);
  if (!isDeepStrictEqual(selected, job.scope))
    throw new Error('Native model result belongs to another scope');
}
function observation(value: unknown, job: ModelJob) {
  const row = modelObject(value);
  exact(row, summary);
  scope(row, job);
  modelText(row.configHash);
  if (row.configuredPrimary !== null) modelText(row.configuredPrimary);
  count(row.fallbackCount);
  nativeModelReference(row.effectiveForNewSessions);
  bool(row.inherited);
  bool(row.reloadOff);
  timestamp(row.checkedAt);
  if (row.sessionSelections !== 'preserved' || row.inferenceVerified !== false)
    throw new Error('Invalid model observation guarantees');
}
function inventory(row: Record<string, unknown>, job: ModelJob) {
  if (job.action.kind !== 'list') throw new Error('Unexpected model inventory');
  scope(row, job);
  const owner = nativeModelScope({ kind: 'agent', agentId: row.catalogAgentId as string });
  if (job.scope.kind === 'agent' && !isDeepStrictEqual(job.scope, owner))
    throw new Error('Native catalog belongs to another agent');
  if (!Array.isArray(row.models) || row.models.length > job.action.limit)
    throw new Error('Invalid model page');
  count(row.total);
  timestamp(row.checkedAt);
  const names = row.models.map((value) => {
    const entry = modelObject(value);
    exact(entry, [
      'model',
      'name',
      'available',
      'unavailableReason',
      'supportsTools',
      'supportsStreaming',
      'contextWindow',
    ]);
    const model = nativeModelReference(entry.model);
    if (
      job.action.kind === 'list' &&
      job.action.provider &&
      !model.startsWith(`${job.action.provider}/`)
    )
      throw new Error('Native catalog belongs to another provider');
    if (entry.name !== undefined) modelText(entry.name, 256);
    for (const key of ['available', 'supportsTools', 'supportsStreaming'])
      if (entry[key] !== undefined) bool(entry[key]);
    if (entry.contextWindow !== undefined) {
      count(entry.contextWindow, Number.MAX_SAFE_INTEGER);
      if (entry.contextWindow === 0) throw new Error('Invalid context size');
    }
    if (
      entry.unavailableReason !== undefined &&
      !['missing-auth', 'not-installed', 'unavailable'].includes(String(entry.unavailableReason))
    )
      throw new Error('Invalid model availability reason');
    return model;
  });
  if (new Set(names).size !== names.length || (row.total as number) < names.length)
    throw new Error('Ambiguous model page');
  const next = job.action.offset + names.length;
  if (row.nextOffset !== null) {
    count(row.nextOffset);
    if (!names.length || row.nextOffset !== next || next >= (row.total as number))
      throw new Error('Invalid next model page');
  } else if (next < (row.total as number))
    throw new Error('Truncated model page without continuation');
  if (
    !Array.isArray(row.pendingProviders) ||
    row.pendingProviders.length > 16 ||
    row.pendingProviders.some(
      (value) => typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value),
    )
  )
    throw new Error('Invalid native refresh status');
  if (row.refreshRequested !== false || row.inferenceVerified !== false)
    throw new Error('Model inventory cannot certify paid inference');
}
/** Parse a bounded, identity-bound public projection only. Unexpected native
 * config/auth fields are rejected before presentation or local persistence. */
export function parseModelResult(
  value: unknown,
  input: ModelJob,
  mode: ModelWorkerMode,
): ModelResult {
  const job = parseModelJob(input);
  if (
    !['execute', 'inspect', 'accept-requested', 'accept-previous'].includes(mode) ||
    (mode !== 'execute' && job.action.kind !== 'set')
  )
    throw new Error('Invalid model result operation mode');
  const row = modelObject(value);
  if (
    Buffer.byteLength(JSON.stringify(row)) > 18000 ||
    row.ok !== true ||
    row.schemaVersion !== 1 ||
    row.operationId !== job.operationId ||
    row.stackId !== job.target.stackId ||
    row.instanceId !== job.target.instanceId
  )
    throw new Error('Model result does not match the pinned operation and host');
  if (mode === 'execute' && job.action.kind !== 'set') {
    if (row.phase !== 'observed')
      throw new Error('Native model read did not return an observation');
    if (job.action.kind === 'list') {
      exact(row, [
        ...header,
        'scope',
        'catalogAgentId',
        'models',
        'total',
        'nextOffset',
        'checkedAt',
        'pendingProviders',
        'refreshRequested',
        'inferenceVerified',
      ]);
      inventory(row, job);
    } else {
      exact(row, [...header, ...summary]);
      observation(Object.fromEntries(summary.map((key) => [key, row[key]])), job);
    }
  } else if (mode === 'inspect') {
    exact(row, [...header, 'maintenanceHeld', 'recordedAt', 'observed', 'replayAllowed']);
    if (
      ![
        'not-started',
        'not-recorded',
        'started',
        'intent',
        'acknowledged',
        'complete',
        'rolled-back',
        'uncertain',
        'unchanged',
      ].includes(String(row.phase))
    )
      throw new Error('Unsupported model inspection phase');
    if (row.phase === 'not-recorded') {
      if (row.maintenanceHeld !== null || row.recordedAt !== null)
        throw new Error('Unrecorded operation ownership is unknown');
    } else bool(row.maintenanceHeld);
    if (row.phase === 'not-started' || row.phase === 'not-recorded') {
      if (row.recordedAt !== null)
        throw new Error('Unstarted operation cannot carry a terminal receipt timestamp');
    } else timestamp(row.recordedAt);
    if (row.observed !== null) observation(row.observed, job);
    if (row.replayAllowed !== false) throw new Error('Model inspection cannot authorize a replay');
  } else if (mode !== 'execute') {
    exact(row, [...header, 'maintenanceHeld', 'reconciled', 'observed', 'replayAllowed']);
    if (
      row.phase !== (mode === 'accept-requested' ? 'complete' : 'rolled-back') &&
      !(mode === 'accept-previous' && row.phase === 'unchanged')
    )
      throw new Error('Model reconciliation did not accept the requested outcome');
    if (row.maintenanceHeld !== false || row.reconciled !== true || row.replayAllowed !== false)
      throw new Error('Model reconciliation remains unresolved');
    observation(row.observed, job);
    if (mode === 'accept-requested') {
      const observed = modelObject(row.observed);
      if (
        job.action.kind !== 'set' ||
        observed.configuredPrimary !== job.action.model ||
        observed.effectiveForNewSessions !== job.action.model
      )
        throw new Error('Reconciliation did not observe the requested model');
    }
  } else if (row.phase === 'complete') {
    exact(row, [...header, ...summary, 'maintenanceHeld', 'restarted']);
    if (row.maintenanceHeld !== false) throw new Error('Model change still owns maintenance');
    bool(row.restarted);
    observation(Object.fromEntries(summary.map((key) => [key, row[key]])), job);
    if (
      job.action.kind !== 'set' ||
      row.effectiveForNewSessions !== job.action.model ||
      row.configuredPrimary !== job.action.model
    )
      throw new Error('Native model result did not publish the requested selection');
  } else {
    exact(row, [...header, 'maintenanceHeld', 'inferenceVerified', 'message', 'replayAllowed']);
    if (!['unchanged', 'rolled-back', 'uncertain'].includes(String(row.phase)))
      throw new Error('Unsupported model mutation phase');
    bool(row.maintenanceHeld);
    modelText(row.message, 512);
    if (
      row.inferenceVerified !== false ||
      (row.phase !== 'uncertain' && row.maintenanceHeld !== false) ||
      (row.phase === 'uncertain' && row.replayAllowed !== false) ||
      (row.replayAllowed !== undefined && row.replayAllowed !== false)
    )
      throw new Error('Invalid model mutation outcome');
  }
  return structuredClone(row) as ModelResult;
}
