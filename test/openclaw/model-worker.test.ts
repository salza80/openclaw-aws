import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runModelOperation, type ModelWorkerHost } from '../../src/openclaw/model-worker.js';
import { modelHostJournal } from '../../src/openclaw/model-journal.js';
import type { ModelSetting, NativeModelClient } from '../../src/openclaw/model-control.js';
import { modelJob } from '../helpers/model-operation.js';
let home: string;
let host: ModelWorkerHost;
let config: { model: ModelSetting; sibling: string };
let published: string;
let revision: number;
let loseReply: boolean;
let failHealth: boolean;
let calls: string[];
const secret = 'fixture-private-native-auth-output';
let catalog: unknown[];
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'openclaw-model-worker-'));
  config = {
    model: { primary: 'openrouter/old', fallbacks: ['openrouter/fallback'] },
    sibling: 'openrouter/sibling',
  };
  published = 'openrouter/old';
  revision = 0;
  loseReply = false;
  failHealth = false;
  calls = [];
  catalog = ['old', 'new', 'fallback'].map((id) => ({
    provider: 'openrouter',
    id,
    available: true,
    supportsTools: true,
    privateAuth: secret,
  }));
  host = {
    home,
    identify: vi.fn(async () => {}),
    client(record): NativeModelClient {
      return {
        record,
        async health() {
          if (failHealth) {
            failHealth = false;
            throw Error(secret);
          }
        },
        async restart() {},
        async call(method, params) {
          calls.push(method);
          if (method === 'agents.list')
            return { defaultId: 'researcher', agents: [{ id: 'researcher' }, { id: 'reviewer' }] };
          if (method === 'config.get')
            return {
              valid: true,
              hash: `opaque:revision:${revision}`,
              config: {
                privateAuth: secret,
                agents: {
                  defaults: { model: 'openrouter/default' },
                  entries: {
                    researcher: { model: structuredClone(config.model) },
                    reviewer: { model: config.sibling },
                  },
                },
              },
            };
          if (method === 'sessions.list')
            return {
              defaults: { modelProvider: published.split('/')[0], model: published.split('/')[1] },
              sessions: [{ transcript: secret }],
            };
          if (method === 'models.list')
            return { models: structuredClone(catalog), privateAuth: secret };
          if (method === 'config.patch') {
            if (params.baseHash !== `opaque:revision:${revision}`) throw Error(secret);
            config.model = JSON.parse(params.raw as string).agents.entries.researcher.model;
            published = typeof config.model === 'string' ? config.model : config.model.primary!;
            revision++;
            if (loseReply) {
              loseReply = false;
              throw Error(secret);
            }
            return { ok: true };
          }
          throw Error('Unexpected native method');
        },
      };
    },
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const writes = () => calls.filter((method) => method === 'config.patch');
describe('durable host model operations', () => {
  it.each([
    [{ available: false, unavailableReason: 'missing-auth' }, /authentication is unavailable/],
    [{ available: false, unavailableReason: 'unavailable' }, /route is unavailable/],
    [{ supportsTools: false }, /unsupported tool use/],
    [{ manualSelectionAllowed: false }, /policy does not permit/],
  ])(
    'reports actionable native preflight guidance without publishing provider diagnostics: %j',
    async (overrides, message) => {
      catalog[1] = { ...(catalog[1] as object), ...overrides, providerDiagnostic: secret };
      const result = await runModelOperation(modelJob, host);
      expect(result).toMatchObject({ phase: 'unchanged', maintenanceHeld: false });
      expect(result).toHaveProperty('message', expect.stringMatching(message));
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(writes()).toHaveLength(0);
      expect(published).toBe('openrouter/old');
    },
  );
  it('reports missing history truthfully and explicitly fences a delayed SSM request without repeating a model write', async () => {
    expect(await runModelOperation(modelJob, host, 'inspect')).toMatchObject({
      phase: 'not-recorded',
      maintenanceHeld: null,
      replayAllowed: false,
    });
    await expect(runModelOperation(modelJob, host, 'accept-requested')).rejects.toThrow(
      /No durable model intent/,
    );
    expect(await runModelOperation(modelJob, host, 'accept-previous')).toMatchObject({
      phase: 'unchanged',
      maintenanceHeld: false,
      reconciled: true,
    });
    await expect(runModelOperation(modelJob, host)).rejects.toThrow(/already started/);
    expect(writes()).toHaveLength(0);
    expect(published).toBe('openrouter/old');
  });
  it('accepts an already settled native commit after a lost client receipt without replaying or reclaiming maintenance', async () => {
    await runModelOperation(modelJob, host);
    expect(await runModelOperation(modelJob, host, 'accept-requested')).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
      reconciled: true,
    });
    expect(writes()).toHaveLength(1);
  });
  it('does not fence a missing-history request as unchanged after its preview revision changed', async () => {
    revision++;
    await expect(runModelOperation(modelJob, host, 'accept-previous')).rejects.toThrow(
      /unchanged preview/,
    );
    expect(writes()).toHaveLength(0);
  });
  it('can explicitly fence a request whose journal was delivered but maintenance was never claimed', async () => {
    await modelHostJournal(home, modelJob, true);
    expect(await runModelOperation(modelJob, host, 'accept-previous')).toMatchObject({
      phase: 'unchanged',
      reconciled: true,
    });
    await expect(runModelOperation(modelJob, host)).rejects.toThrow(/already started/);
    expect(writes()).toHaveLength(0);
  });
  it('retains a preflight hold when another native writer changed its preview before any model intent', async () => {
    const journal = await modelHostJournal(home, modelJob, true);
    await journal.claim();
    await journal.append({ phase: 'started' });
    revision++;
    await expect(runModelOperation(modelJob, host, 'accept-previous')).rejects.toThrow(
      /preview changed before model intent/,
    );
    expect(await journal.ownsMaintenance()).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it('publishes a minimal result and releases maintenance after native commit, without recording or reporting auth/config/session contents', async () => {
    const result = await runModelOperation(modelJob, host);
    expect(result).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
      configuredPrimary: 'openrouter/new',
      effectiveForNewSessions: 'openrouter/new',
      fallbackCount: 1,
      inferenceVerified: false,
    });
    expect(config.sibling).toBe('openrouter/sibling');
    expect(config.model).toEqual({ primary: 'openrouter/new', fallbacks: ['openrouter/fallback'] });
    const journal = await modelHostJournal(home, modelJob, false);
    expect((await journal.events()).map((row) => row.phase)).toEqual([
      'started',
      'intent',
      'acknowledged',
      'complete',
    ]);
    expect(await journal.ownsMaintenance()).toBe(false);
    const work = path.join(home, '.openclaw-aws/models', modelJob.operationId);
    const files = await Promise.all(
      (await readdir(work)).map((name) => readFile(path.join(work, name), 'utf8')),
    );
    expect(JSON.stringify([result, ...files])).not.toContain(secret);
    await expect(runModelOperation(modelJob, host)).rejects.toThrow(/already started/);
    expect(writes()).toHaveLength(1);
  });
  it('retains an unacknowledged write, inspects its live outcome and explicitly adopts it without replay', async () => {
    loseReply = true;
    expect(await runModelOperation(modelJob, host)).toMatchObject({
      phase: 'uncertain',
      maintenanceHeld: true,
      replayAllowed: false,
    });
    expect(await runModelOperation(modelJob, host, 'inspect')).toMatchObject({
      phase: 'uncertain',
      maintenanceHeld: true,
      observed: { effectiveForNewSessions: 'openrouter/new' },
    });
    await expect(runModelOperation(modelJob, host, 'accept-previous')).rejects.toThrow(/differs/);
    expect(await runModelOperation(modelJob, host, 'accept-requested')).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
      reconciled: true,
    });
    expect(writes()).toHaveLength(1);
    expect(await runModelOperation(modelJob, host, 'inspect')).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
    });
  });
  it('reports verified rollback and releases the hold only after native readback', async () => {
    failHealth = true;
    expect(await runModelOperation(modelJob, host)).toMatchObject({
      phase: 'rolled-back',
      maintenanceHeld: false,
    });
    expect(published).toBe('openrouter/old');
    expect(writes()).toHaveLength(2);
  });
  it('retains maintenance after failed rollback validation even if the old file selection is present', async () => {
    const original = host.client;
    host.client = (record) => ({
      ...original(record),
      async health() {
        throw Error(secret);
      },
    });
    expect(await runModelOperation(modelJob, host)).toMatchObject({
      phase: 'uncertain',
      maintenanceHeld: true,
    });
    expect(published).toBe('openrouter/old');
    await expect(runModelOperation(modelJob, host, 'accept-previous')).rejects.toThrow();
    expect(await (await modelHostJournal(home, modelJob, false)).ownsMaintenance()).toBe(true);
    expect(writes()).toHaveLength(2);
    host.client = original;
    expect(await runModelOperation(modelJob, host, 'accept-previous')).toMatchObject({
      phase: 'rolled-back',
      maintenanceHeld: false,
    });
    expect(writes()).toHaveLength(2);
  });
  it('rejects a native revision change during reconciliation health checks', async () => {
    loseReply = true;
    await runModelOperation(modelJob, host);
    const original = host.client;
    host.client = (record) => ({
      ...original(record),
      async health() {
        revision++;
      },
    });
    await expect(runModelOperation(modelJob, host, 'accept-requested')).rejects.toThrow(
      /changed during reconciliation/,
    );
    expect(await (await modelHostJournal(home, modelJob, false)).ownsMaintenance()).toBe(true);
    expect(writes()).toHaveLength(1);
  });
  it('explicitly releases a crash before model intent without issuing a model patch', async () => {
    const journal = await modelHostJournal(home, modelJob, true);
    await journal.claim();
    await expect(runModelOperation(modelJob, host, 'accept-requested')).rejects.toThrow(
      /No durable model intent/,
    );
    expect(await runModelOperation(modelJob, host, 'accept-previous')).toMatchObject({
      phase: 'unchanged',
      maintenanceHeld: false,
      reconciled: true,
    });
    expect(writes()).toHaveLength(0);
  });
  it('records unchanged preflight and releases the hold without a native write on stale previews', async () => {
    revision = 1;
    expect(await runModelOperation(modelJob, host)).toMatchObject({
      phase: 'unchanged',
      maintenanceHeld: false,
    });
    expect(writes()).toHaveLength(0);
    expect(
      (await (await modelHostJournal(home, modelJob, false)).events()).map((row) => row.phase),
    ).toEqual(['started', 'unchanged']);
  });
  it('does not enter native control or create files after failed AWS host identity', async () => {
    host.identify = vi.fn(async () => {
      throw Error('wrong-instance');
    });
    await expect(runModelOperation(modelJob, host)).rejects.toThrow(/wrong-instance/);
    expect(calls).toHaveLength(0);
    expect(await readdir(home)).toEqual([]);
  });
  it('preserves a concurrent native writer and refuses acceptance of an unrelated selection', async () => {
    loseReply = true;
    await runModelOperation(modelJob, host);
    config.model = 'openrouter/other';
    published = 'openrouter/other';
    revision++;
    await expect(runModelOperation(modelJob, host, 'accept-requested')).rejects.toThrow(/differs/);
    await expect(runModelOperation(modelJob, host, 'accept-previous')).rejects.toThrow(/differs/);
    expect(await (await modelHostJournal(home, modelJob, false)).ownsMaintenance()).toBe(true);
    expect(writes()).toHaveLength(1);
  });
  it('explicitly accepts the restored previous state without applying a rollback after a lost reply', async () => {
    loseReply = true;
    await runModelOperation(modelJob, host);
    config.model = { primary: 'openrouter/old', fallbacks: ['openrouter/fallback'] };
    published = 'openrouter/old';
    revision++;
    expect(await runModelOperation(modelJob, host, 'accept-previous')).toMatchObject({
      phase: 'rolled-back',
      maintenanceHeld: false,
      reconciled: true,
    });
    expect(writes()).toHaveLength(1);
  });
  it('shows unavailable live state truthfully and does not turn historical completion into current health', async () => {
    await runModelOperation(modelJob, host);
    host.client = () => ({
      call: async () => {
        throw Error(secret);
      },
      health: async () => {},
      restart: async () => {},
      record: async () => {},
    });
    const result = await runModelOperation(modelJob, host, 'inspect');
    expect(result).toMatchObject({ phase: 'complete', observed: null, maintenanceHeld: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('pages the native inventory by byte budget with explicit catalog ownership and secret-free projections', async () => {
    catalog = Array.from({ length: 60 }, (_, i) => ({
      provider: 'openrouter',
      id: `model-${i}-${'x'.repeat(1800)}`,
      name: `Model ${i}`,
      available: true,
      privateAuth: secret,
    }));
    const job = {
      ...modelJob,
      scope: { kind: 'default' },
      action: { kind: 'list', provider: 'openrouter', offset: 0, limit: 50 },
    };
    const first = await runModelOperation(job, host);
    expect(first).toMatchObject({
      phase: 'observed',
      catalogAgentId: 'researcher',
      total: 60,
      refreshRequested: false,
      inferenceVerified: false,
    });
    const page = first as unknown as { models: unknown[]; nextOffset: number };
    expect(page.models.length).toBeGreaterThan(0);
    expect(page.models.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(18000);
    const next = (await runModelOperation(
      { ...job, action: { ...job.action, offset: page.nextOffset } },
      host,
    )) as unknown as { models: unknown[] };
    expect(next.models[0]).toEqual(expect.objectContaining({ name: `Model ${page.nextOffset}` }));
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(writes()).toHaveLength(0);
    expect(await readdir(home)).toEqual([]);
  });
  it('refuses absent agents, invalid model rows and duplicate inventory instead of returning partial trusted results', async () => {
    const list = { ...modelJob, action: { kind: 'list', offset: 0, limit: 20 } };
    await expect(
      runModelOperation({ ...list, scope: { kind: 'agent', agentId: 'absent' } }, host),
    ).rejects.toThrow(/absent/);
    catalog = [{ provider: undefined, id: undefined }];
    await expect(runModelOperation(list, host)).rejects.toThrow(/invalid model/);
    catalog = [
      { provider: 'openrouter', id: 'same' },
      { provider: 'openrouter', id: 'same' },
    ];
    await expect(runModelOperation(list, host)).rejects.toThrow(/duplicate/);
    expect(writes()).toHaveLength(0);
  });
});
