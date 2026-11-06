import { isDeepStrictEqual } from 'node:util';
import {
  changeModelSelection,
  inspectModelSelection,
  nativeModelReference,
  nativeModelScope,
  ModelControlError,
  type ModelMutationRecord,
  type ModelSelectionObservation,
  type ModelSetting,
  type NativeModelClient,
} from './model-control.js';
import { modelObject, parseModelJob, type ModelJob } from './model-contract.js';
import { modelHostJournal } from './model-journal.js';

export interface ModelWorkerHost {
  home: string;
  /** Real worker verifies IMDSv2/STS account, role ID and EC2 session before reads/writes. */
  identify(): Promise<void>;
  client(record: (value: ModelMutationRecord) => Promise<void>): NativeModelClient;
}
const primary = (value: ModelSetting | null) =>
  typeof value === 'string' ? value : (value?.primary ?? null);
/** Output excludes raw native config, auth, session text and arbitrary provider
 * diagnostics. A bounded projection also avoids SSM's inline output truncation. */
function observation(value: ModelSelectionObservation) {
  return {
    scope: value.scope,
    configHash: value.configHash,
    configuredPrimary: primary(value.configured),
    fallbackCount:
      typeof value.configured === 'object' ? (value.configured?.fallbacks?.length ?? 0) : 0,
    effectiveForNewSessions: value.effectiveForNewSessions,
    inherited: value.inherited,
    reloadOff: value.reloadOff,
    checkedAt: value.checkedAt,
    sessionSelections: 'preserved' as const,
    inferenceVerified: false as const,
  };
}
async function inventory(client: NativeModelClient, job: ModelJob) {
  if (job.action.kind !== 'list') throw new Error('Inventory request is invalid');
  const roster = modelObject(await client.call('agents.list', {}));
  if (!Array.isArray(roster.agents) || !roster.agents.length)
    throw new Error('Native agent roster is unavailable');
  const ids = roster.agents
    .map((value) => nativeModelScope({ kind: 'agent', agentId: modelObject(value).id as string }))
    .map((value) => (value as { agentId: string }).agentId);
  if (new Set(ids).size !== ids.length) throw new Error('Native agent roster is ambiguous');
  const agentId =
    job.scope.kind === 'agent'
      ? job.scope.agentId
      : typeof roster.defaultId === 'string' && ids.includes(roster.defaultId)
        ? roster.defaultId
        : ids[0];
  if (!ids.includes(agentId)) throw new Error('Requested native agent is absent');
  const result = modelObject(
    await client.call('models.list', {
      agentId,
      ...(job.action.provider ? { provider: job.action.provider } : {}),
      view: 'default',
      includeDetails: true,
    }),
  );
  if (!Array.isArray(result.models) || result.models.length > 100000)
    throw new Error('Native inventory is unavailable or oversized');
  const rows = result.models
    .map((value) => {
      const row = modelObject(value);
      if (typeof row.provider !== 'string' || typeof row.id !== 'string')
        throw new Error('Native inventory contains an invalid model');
      const model = nativeModelReference(`${row.provider}/${row.id}`);
      return {
        model,
        ...(['missing-auth', 'not-installed', 'unavailable'].includes(String(row.unavailableReason))
          ? { unavailableReason: row.unavailableReason as string }
          : {}),
        ...(typeof row.name === 'string' && row.name.length <= 256 && !/[\r\n\0]/.test(row.name)
          ? { name: row.name }
          : {}),
        ...(typeof row.available === 'boolean' ? { available: row.available } : {}),
        ...(typeof row.supportsTools === 'boolean' ? { supportsTools: row.supportsTools } : {}),
        ...(typeof row.supportsStreaming === 'boolean'
          ? { supportsStreaming: row.supportsStreaming }
          : {}),
        ...(typeof row.contextWindow === 'number' &&
        Number.isSafeInteger(row.contextWindow) &&
        row.contextWindow > 0
          ? { contextWindow: row.contextWindow }
          : {}),
      };
    })
    .filter(
      (row) =>
        !job.action ||
        job.action.kind !== 'list' ||
        !job.action.provider ||
        row.model.startsWith(`${job.action.provider}/`),
    );
  if (new Set(rows.map((row) => row.model)).size !== rows.length)
    throw new Error('Native inventory contains duplicate model keys');
  const page = rows.slice(job.action.offset, job.action.offset + job.action.limit);
  while (Buffer.byteLength(JSON.stringify(page)) > 12000) page.pop();
  const next = job.action.offset + page.length;
  return {
    scope: job.scope,
    catalogAgentId: agentId,
    models: page,
    total: rows.length,
    nextOffset: next < rows.length ? next : null,
    checkedAt: new Date().toISOString(),
    pendingProviders: Array.isArray(result.pendingProviders)
      ? result.pendingProviders
          .filter(
            (value): value is string =>
              typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value),
          )
          .slice(0, 16)
      : [],
    // Read the published inventory only. Native refresh and any paid probe are
    // separate explicit operations, never a side effect of listing models.
    refreshRequested: false,
    inferenceVerified: false,
  };
}
export type ModelWorkerMode = 'execute' | 'inspect' | 'accept-requested' | 'accept-previous';
/** Entry point holds the shared host flock. Reconciliation is a read/acceptance
 * operation: it never repeats a config.patch or silently overwrites native work. */
export async function runModelOperation(
  input: unknown,
  host: ModelWorkerHost,
  mode: ModelWorkerMode = 'execute',
) {
  const job = parseModelJob(input);
  if (!['execute', 'inspect', 'accept-requested', 'accept-previous'].includes(mode))
    throw new Error('Unsupported model worker mode');
  await host.identify();
  const header = {
    schemaVersion: 1,
    operationId: job.operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
  };
  const readOnly = host.client(async () => {
    throw new Error('A read-only model operation attempted a write');
  });
  if (job.action.kind !== 'set') {
    if (mode !== 'execute') throw new Error('Only a recorded mutation can be reconciled');
    return {
      ...header,
      phase: 'observed',
      ...(job.action.kind === 'list'
        ? await inventory(readOnly, job)
        : observation(await inspectModelSelection(readOnly, job.scope))),
    };
  }
  const journal = await modelHostJournal(host.home, job, mode === 'execute');
  if (mode !== 'execute') {
    const events = await journal.events();
    const mutations = events.filter(
      (value): value is ModelMutationRecord & { checkedAt: string } => 'scope' in value,
    );
    const intent = mutations[0];
    const latest = events.at(-1);
    const held = await journal.ownsMaintenance();
    let current: ModelSelectionObservation | undefined;
    try {
      current = await inspectModelSelection(readOnly, job.scope);
    } catch {
      /* Report unavailable instead of historic state as live. */
    }
    if (mode === 'inspect')
      return {
        ...header,
        phase: latest?.phase ?? 'not-started',
        maintenanceHeld: held,
        recordedAt: latest?.checkedAt ?? null,
        observed: current ? observation(current) : null,
        replayAllowed: false,
      };
    if (!held || !current)
      throw new Error('Reconciliation requires owned maintenance and a fresh native observation');
    // A crash before the first model intent has no write to adopt. Only the
    // explicit previous-state acceptance may release that preflight hold.
    if (!intent) {
      if (
        mode !== 'accept-previous' ||
        events.some((value) => value.phase !== 'started' && value.phase !== 'unchanged')
      )
        throw new Error('No durable model intent exists to reconcile');
      if (latest?.phase !== 'unchanged') await journal.append({ phase: 'unchanged' });
    } else {
      const requested = mode === 'accept-requested';
      const desired =
        typeof intent.previous === 'string'
          ? intent.requested
          : { ...intent.previous, primary: intent.requested };
      if (
        !isDeepStrictEqual(current.configured, requested ? desired : intent.previous) ||
        current.effectiveForNewSessions !==
          (requested ? intent.requested : intent.previousPublished)
      )
        throw new Error(
          'Observed native model differs from the explicitly selected reconciliation outcome; hold retained',
        );
      await readOnly.health();
      // Health can overlap a native writer: bind acceptance to another complete
      // observation rather than release on a model read made before the check.
      const confirmed = await inspectModelSelection(readOnly, job.scope);
      if (
        confirmed.configHash !== current.configHash ||
        confirmed.effectiveForNewSessions !== current.effectiveForNewSessions
      )
        throw new Error('Native selection changed during reconciliation; hold retained');
      current = confirmed;
      const phase = requested ? 'complete' : 'rolled-back';
      if (latest?.phase !== phase) await journal.append({ ...intent, phase });
    }
    await journal.release();
    return {
      ...header,
      phase: intent ? (mode === 'accept-requested' ? 'complete' : 'rolled-back') : 'unchanged',
      maintenanceHeld: false,
      reconciled: true,
      observed: observation(current),
      replayAllowed: false,
    };
  }
  await journal.claim();
  await journal.append({ phase: 'started' });
  const client = host.client((value) => journal.append(value));
  try {
    const changed = await changeModelSelection(client, { scope: job.scope, ...job.action });
    await journal.release();
    return {
      ...header,
      phase: 'complete',
      maintenanceHeld: false,
      restarted: changed.restarted,
      ...observation(changed),
    };
  } catch (error) {
    const events = await journal.events();
    const latest = events.at(-1);
    const attempted = events.some((value) => value.phase === 'intent');
    // Preflight failures have no native write. After intent, only a verified
    // rollback/commit permits release; ambiguous writes retain maintenance.
    if (!attempted) {
      await journal.append({ phase: 'unchanged' });
      await journal.release();
      return {
        ...header,
        phase: 'unchanged',
        maintenanceHeld: false,
        inferenceVerified: false,
        message:
          error instanceof ModelControlError
            ? error.message
            : 'Native model preflight failed. Check provider authentication, model inventory and compatibility; no model write was attempted.',
      };
    }
    if (latest?.phase === 'rolled-back') {
      await journal.release();
      return {
        ...header,
        phase: 'rolled-back',
        maintenanceHeld: false,
        inferenceVerified: false,
        message:
          'Model change failed; the previous selection and published defaults were restored.',
      };
    }
    return {
      ...header,
      phase: 'uncertain',
      maintenanceHeld: await journal.ownsMaintenance(),
      replayAllowed: false,
      inferenceVerified: false,
      message:
        'The model change could not be confirmed. Inspect this operation and explicitly reconcile its observed state before another mutation; do not replay it.',
    };
  }
}
