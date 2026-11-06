import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changeModelSelection,
  inspectModelSelection,
  ModelControlError,
  type ModelSetting,
  type NativeModelClient,
} from '../../src/openclaw/model-control.js';
type Config = {
  agents: {
    defaults: { model?: ModelSetting; modelPolicy?: { allow: string[] } };
    entries: Record<string, { model?: ModelSetting; workspace?: string }>;
  };
  gateway: { reload: { mode: string } };
  privateProviderSecret: string;
};
let saved: Config;
let runtime: Config;
let client: NativeModelClient;
let suppressPublish: boolean;
let loseAck: boolean;
let catalog: {
  provider: string;
  id: string;
  available?: boolean;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  unavailableReason?: string;
}[];
const scope = { kind: 'agent' as const, agentId: 'researcher' };
const sessions = [
  {
    key: 'agent:researcher:retained',
    modelOverride: 'pinned-model',
    providerOverride: 'openrouter',
  },
];
// Public Gateway revisions are opaque projected tokens, not raw file digests.
const hash = () =>
  `revision:${createHash('sha256').update(JSON.stringify(saved)).digest('base64url')}`;
const primary = (value: ModelSetting | undefined) =>
  typeof value === 'string' ? value : value?.primary;
const effective = (config: Config, agentId?: string) => {
  const chosen = agentId ? primary(config.agents.entries[agentId]?.model) : undefined;
  const value = chosen ?? primary(config.agents.defaults.model)!;
  return value === 'legacy-alias' ? 'openrouter/old' : value;
};
function merge(base: Record<string, unknown>, delta: Record<string, unknown>) {
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) delete base[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!base[key] || typeof base[key] !== 'object' || Array.isArray(base[key])) base[key] = {};
      merge(base[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else base[key] = value;
  }
}
beforeEach(() => {
  saved = {
    agents: {
      defaults: { model: { primary: 'openrouter/old', fallbacks: ['openrouter/fallback'] } },
      entries: {
        coordinator: { workspace: '/coordinator' },
        researcher: {
          model: { primary: 'openrouter/old', fallbacks: ['openrouter/fallback'] },
          workspace: '/researcher',
        },
        reviewer: { model: 'openrouter/reviewer' },
      },
    },
    gateway: { reload: { mode: 'hybrid' } },
    privateProviderSecret: 'fixture-secret-must-not-enter-journal',
  };
  runtime = structuredClone(saved);
  suppressPublish = false;
  loseAck = false;
  catalog = ['old', 'new', 'fallback', 'reviewer', 'external'].map((id) => ({
    provider: 'openrouter',
    id,
    available: true,
    supportsTools: true,
  }));
  client = {
    call: vi.fn(async (method, params) => {
      if (method === 'config.get')
        return { valid: true, hash: hash(), config: structuredClone(saved) };
      if (method === 'agents.list')
        return { agents: Object.keys(saved.agents.entries).map((id) => ({ id })) };
      if (method === 'models.list') {
        if (!params.agentId && Object.keys(saved.agents.entries).length > 1)
          throw Error('native catalog owner required');
        return {
          models: structuredClone(
            catalog.filter(
              (row) =>
                row.provider === params.provider &&
                (params.view !== 'default' ||
                  !saved.agents.defaults.modelPolicy ||
                  saved.agents.defaults.modelPolicy.allow.includes(`${row.provider}/${row.id}`)),
            ),
          ),
        };
      }
      if (method === 'sessions.list') {
        const model = effective(runtime, params.agentId as string | undefined);
        const slash = model.indexOf('/');
        return {
          defaults: { modelProvider: model.slice(0, slash), model: model.slice(slash + 1) },
          sessions: structuredClone(sessions),
        };
      }
      if (method === 'config.patch') {
        if (params.baseHash !== hash()) throw Error('native revision conflict');
        merge(saved as unknown as Record<string, unknown>, JSON.parse(params.raw as string));
        if (!suppressPublish && saved.gateway.reload.mode !== 'off')
          runtime = structuredClone(saved);
        suppressPublish = false;
        if (loseAck) {
          loseAck = false;
          throw Error('lost native reply');
        }
        return { ok: true, hash: hash() };
      }
      throw Error('Unexpected or mutating session method');
    }),
    health: vi.fn(async () => {}),
    restart: vi.fn(async () => {
      runtime = structuredClone(saved);
    }),
    record: vi.fn(async () => {}),
  };
});
const mutations = () =>
  vi.mocked(client.call).mock.calls.filter(([method]) => method === 'config.patch');
const change = (extra: Partial<Parameters<typeof changeModelSelection>[1]> = {}) =>
  changeModelSelection(client, { scope, model: 'openrouter/new', expectedHash: hash(), ...extra });
describe('native persistent model control', () => {
  it('refuses a Bedrock catalog entry explicitly lacking streaming before writing any intent', async () => {
    catalog.push({
      provider: 'amazon-bedrock',
      id: 'non-streaming',
      available: true,
      supportsTools: true,
      supportsStreaming: false,
    });
    await expect(change({ model: 'amazon-bedrock/non-streaming' })).rejects.toThrow(
      /unsupported response streaming/,
    );
    expect(mutations()).toHaveLength(0);
    expect(client.record).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0])(
    'rejects missing/invalid published defaults instead of stringifying them: %s',
    async (value) => {
      const original = client.call;
      client.call = vi.fn((method, params) =>
        method === 'sessions.list'
          ? Promise.resolve({ defaults: { modelProvider: value, model: value } })
          : original(method, params),
      );
      await expect(inspectModelSelection(client, scope)).rejects.toThrow(
        /published model defaults/,
      );
      expect(mutations()).toHaveLength(0);
    },
  );
  it('changes only the selected agent primary, preserving fallbacks, siblings, sessions and credential privacy', async () => {
    const before = structuredClone(saved);
    const result = await change();
    expect(result).toMatchObject({
      requested: 'openrouter/new',
      effectiveForNewSessions: 'openrouter/new',
      inferenceVerified: false,
      sessionSelections: 'preserved',
      restarted: false,
    });
    expect(saved.agents.defaults).toEqual(before.agents.defaults);
    expect(saved.agents.entries.coordinator).toEqual(before.agents.entries.coordinator);
    expect(saved.agents.entries.reviewer).toEqual(before.agents.entries.reviewer);
    expect(saved.agents.entries.researcher).toEqual({
      ...before.agents.entries.researcher,
      model: { primary: 'openrouter/new', fallbacks: ['openrouter/fallback'] },
    });
    expect(JSON.stringify(vi.mocked(client.record).mock.calls)).not.toContain(
      saved.privateProviderSecret,
    );
    expect(vi.mocked(client.record).mock.calls.map(([entry]) => entry.phase)).toEqual([
      'intent',
      'acknowledged',
      'complete',
    ]);
    expect(sessions[0].modelOverride).toBe('pinned-model');
    expect(mutations()).toHaveLength(1);
  });
  it('changes Gateway defaults while retaining explicit per-agent settings', async () => {
    const roster = structuredClone(saved.agents.entries);
    await change({ scope: { kind: 'default' } });
    expect(saved.agents.entries).toEqual(roster);
    expect(effective(runtime, 'coordinator')).toBe('openrouter/new');
    expect(effective(runtime, 'reviewer')).toBe('openrouter/reviewer');
    expect(saved.agents.defaults.model).toEqual({
      primary: 'openrouter/new',
      fallbacks: ['openrouter/fallback'],
    });
    expect(
      vi
        .mocked(client.call)
        .mock.calls.filter(([method]) => method === 'models.list')
        .map(([, params]) => params.agentId),
    ).toEqual(['coordinator']);
  });
  it('observes persisted versus published drift, including inherited agent selections', async () => {
    delete saved.agents.entries.coordinator.model;
    saved.agents.defaults.model = 'openrouter/new';
    saved.gateway.reload.mode = 'off';
    const observed = await inspectModelSelection(client, { kind: 'agent', agentId: 'coordinator' });
    expect(observed).toMatchObject({
      configured: null,
      inherited: true,
      effectiveForNewSessions: 'openrouter/old',
      reloadOff: true,
    });
    expect(mutations()).toHaveLength(0);
  });
  it('rejects an obsolete preview and unknown agents without writing or creating ownership', async () => {
    await expect(change({ expectedHash: '0'.repeat(64) })).rejects.toMatchObject({
      outcome: 'conflict',
    });
    await expect(change({ scope: { kind: 'agent', agentId: 'absent' } })).rejects.toThrow(/absent/);
    expect(mutations()).toHaveLength(0);
    expect(client.record).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'default' as const }, scope])(
    'respects native model policy at %j scope before writing any intent',
    async (targetScope) => {
      saved.agents.defaults.modelPolicy = { allow: ['openrouter/old'] };
      runtime = structuredClone(saved);
      await expect(change({ scope: targetScope })).rejects.toThrow(/agent policy/);
      expect(mutations()).toHaveLength(0);
      expect(client.record).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(client.call)
          .mock.calls.filter(([method]) => method === 'models.list')
          .every(([, params]) => params.view === 'default'),
      ).toBe(true);
    },
  );
  it.each([
    { available: false, unavailableReason: 'missing-auth', message: /authentication/ },
    { supportsTools: false, message: /unsupported tool/ },
  ])(
    'rejects native credential/capability failures before mutation: $message',
    async ({ message, ...changes }) => {
      Object.assign(
        catalog.find((row) => row.id === 'new')!,
        changes,
      );
      await expect(change()).rejects.toThrow(message);
      expect(mutations()).toHaveLength(0);
    },
  );
  it('refuses an absent catalog key instead of guessing a provider route or sending inference', async () => {
    await expect(change({ model: 'openrouter/unknown' })).rejects.toThrow(
      /absent from native inventory/,
    );
    expect(mutations()).toHaveLength(0);
  });
  it('requires restart approval when reload is off and verifies publication after restart', async () => {
    saved.gateway.reload.mode = 'off';
    runtime = structuredClone(saved);
    await expect(change()).rejects.toMatchObject({ outcome: 'unchanged' });
    expect(mutations()).toHaveLength(0);
    const result = await change({ allowRestart: true });
    expect(result.restarted).toBe(true);
    expect(client.restart).toHaveBeenCalledTimes(1);
    expect(result.effectiveForNewSessions).toBe('openrouter/new');
  });
  it('rolls back acknowledged changes after failed health, preserving fallbacks and native aliases', async () => {
    saved.agents.entries.researcher.model = 'legacy-alias';
    runtime = structuredClone(saved);
    vi.mocked(client.health).mockRejectedValueOnce(Error('private native failure'));
    await expect(change()).rejects.toMatchObject({ outcome: 'rolled-back' });
    expect(saved.agents.entries.researcher.model).toBe('legacy-alias');
    expect(effective(runtime, 'researcher')).toBe('openrouter/old');
    expect(mutations()).toHaveLength(2);
  });
  it('does not call a persisted-only change effective; rollback must also be published', async () => {
    const before = structuredClone(saved);
    suppressPublish = true;
    await expect(change()).rejects.toMatchObject({ outcome: 'rolled-back' });
    expect(saved).toEqual(before);
    expect(runtime).toEqual(before);
  });
  it('preserves a concurrent writer instead of rolling their selection back', async () => {
    vi.mocked(client.health).mockImplementationOnce(async () => {
      saved.agents.entries.researcher.model = 'openrouter/external';
      runtime = structuredClone(saved);
    });
    await expect(change()).rejects.toMatchObject({ outcome: 'conflict' });
    expect(saved.agents.entries.researcher.model).toBe('openrouter/external');
    expect(mutations()).toHaveLength(1);
  });
  it('leaves an unacknowledged native write for reconciliation rather than replaying or blindly rolling back', async () => {
    loseAck = true;
    await expect(change()).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(effective(runtime, 'researcher')).toBe('openrouter/new');
    expect(mutations()).toHaveLength(1);
    expect(vi.mocked(client.record).mock.calls.at(-1)?.[0].phase).toBe('uncertain');
  });
  it('rolls back when the completion receipt cannot be committed', async () => {
    vi.mocked(client.record).mockImplementation(async (entry) => {
      if (entry.phase === 'complete') throw Error('disk failure');
    });
    await expect(change()).rejects.toMatchObject({ outcome: 'rolled-back' });
    expect(effective(runtime, 'researcher')).toBe('openrouter/old');
  });
  it('reports uncertainty without leaking private failures when rollback is unconfirmed', async () => {
    vi.mocked(client.health).mockRejectedValue(Error(saved.privateProviderSecret));
    try {
      await change();
      throw Error('expected a failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelControlError);
      expect(error).toMatchObject({ outcome: 'uncertain' });
      expect(String(error)).not.toContain(saved.privateProviderSecret);
    }
  });
});
