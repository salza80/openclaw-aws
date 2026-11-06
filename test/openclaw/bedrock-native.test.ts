import { describe, it, expect, vi } from 'vitest';
import {
  bedrockUnrelatedConfigHash,
  ensureNativeBedrockPlugin,
  inspectNativeBedrockPlugin,
  refreshNativeBedrockDiscovery,
} from '../../src/openclaw/bedrock-native.js';
import { NativeCapabilityConsentRequired } from '../../src/openclaw/model-client.js';
import { BEDROCK_PLUGIN } from '../../src/openclaw/bedrock-configuration.js';
import { parseServiceEnvironment } from '../../src/openclaw/bedrock-host.js';
describe('native Bedrock plugin and catalog boundary', () => {
  it('installs only the pinned artifact through public RPC and acknowledges only its typed pre-persistence capability gate', async () => {
    let installed = false,
      enabled = false,
      gate = true;
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'plugins.list')
        return { plugins: [{ id: BEDROCK_PLUGIN.id, installed, enabled, version: '2026.11.1' }] };
      if (method === 'plugins.inspect')
        return {
          ok: true,
          plugin: { id: BEDROCK_PLUGIN.id, version: '2026.11.1', enabled },
          source: { kind: 'npm', spec: BEDROCK_PLUGIN.spec, integrity: BEDROCK_PLUGIN.integrity },
        };
      if (method === 'plugins.install') {
        if (gate) {
          gate = false;
          throw new NativeCapabilityConsentRequired(BEDROCK_PLUGIN.id, 'native-review-token');
        }
        expect(params).toMatchObject({
          source: 'npm',
          spec: BEDROCK_PLUGIN.spec.slice(4),
          expectedIntegrity: BEDROCK_PLUGIN.integrity,
          expectedPluginId: BEDROCK_PLUGIN.id,
          pin: true,
          enable: false,
          acknowledgeCapabilities: { reviewToken: 'native-review-token' },
        });
        installed = true;
        return { ok: true };
      }
      if (method === 'plugins.setEnabled') {
        expect(params).toEqual({
          pluginId: BEDROCK_PLUGIN.id,
          enabled: true,
          allowlistPolicy: 'preserve',
        });
        enabled = true;
        return { ok: true };
      }
      throw Error('Unsupported native method');
    });
    await ensureNativeBedrockPlugin({ call }, true);
    expect(installed && enabled).toBe(true);
    expect(call.mock.calls.filter(([method]) => method === 'plugins.install')).toHaveLength(2);
    await ensureNativeBedrockPlugin({ call }, true);
    expect(call.mock.calls.filter(([method]) => method === 'plugins.install')).toHaveLength(2);
  });
  it('refuses foreign plugin provenance and never retries a lost install reply', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'plugins.list'
        ? { plugins: [{ id: BEDROCK_PLUGIN.id, installed: true, version: '2026.11.1' }] }
        : {
            ok: true,
            plugin: { id: BEDROCK_PLUGIN.id, version: '2026.11.1' },
            source: { kind: 'path', integrity: BEDROCK_PLUGIN.integrity },
          },
    );
    await expect(inspectNativeBedrockPlugin({ call })).rejects.toThrow(/provenance/);
    call.mockImplementation(async (method: string) => {
      if (method === 'plugins.list') return { plugins: [] };
      throw Error('lost-private-reply');
    });
    await expect(ensureNativeBedrockPlugin({ call }, true)).rejects.toThrow('lost-private-reply');
    expect(call.mock.calls.filter(([method]) => method === 'plugins.install')).toHaveLength(1);
    await expect(ensureNativeBedrockPlugin({ call }, false)).rejects.toThrow(/Approve/);
  });
  it('waits for asynchronous provider publication with one metadata refresh and preserves native policy scope', async () => {
    let reads = 0;
    const health = vi.fn(async () => {});
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'agents.list')
        return { defaultId: 'coordinator', agents: [{ id: 'coordinator' }, { id: 'researcher' }] };
      expect(params).toMatchObject({
        agentId: 'coordinator',
        provider: 'amazon-bedrock',
        view: 'default',
        includeDetails: true,
      });
      return ++reads < 3
        ? { models: [] }
        : { models: [], providerOutcomes: [{ provider: 'amazon-bedrock', status: 'ready' }] };
    });
    expect(await refreshNativeBedrockDiscovery({ call, health }, { pollMs: 0 })).toMatchObject({
      ready: true,
      visibleModels: 0,
      inferenceVerified: false,
    });
    expect(call.mock.calls.filter(([, params]) => params?.refresh === true)).toHaveLength(1);
    expect(health).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['auth-rejected', /denied/],
    ['unavailable', /connectivity/],
  ])('reports native catalog outcome %s without inference', async (status, message) => {
    const call = vi.fn(async (method: string) =>
      method === 'agents.list'
        ? { agents: [{ id: 'main' }] }
        : { models: [], providerOutcomes: [{ provider: 'amazon-bedrock', status }] },
    );
    await expect(
      refreshNativeBedrockDiscovery({ call, health: async () => {} }, { pollMs: 0 }),
    ).rejects.toThrow(message);
  });
  it('does not hide unrelated empty tool policy or another plugin while allowing only native Bedrock enablement bookkeeping', () => {
    const original = {
      agents: { entries: { researcher: { tools: { allow: [] } } } },
      plugins: { allow: ['other'], entries: { other: { enabled: true } } },
    };
    const enabled = structuredClone(original) as Record<string, unknown>;
    enabled.plugins = {
      allow: ['other', 'amazon-bedrock'],
      entries: { other: { enabled: true }, 'amazon-bedrock': { enabled: true, config: {} } },
    };
    enabled.meta = { lastTouchedAt: 'now', lastTouchedVersion: '2026.11.1' };
    expect(bedrockUnrelatedConfigHash(enabled)).toBe(bedrockUnrelatedConfigHash(original));
    expect(
      bedrockUnrelatedConfigHash({
        ...original,
        agents: { entries: { researcher: { tools: {} } } },
      }),
    ).not.toBe(bedrockUnrelatedConfigHash(original));
  });
  it('parses private service environment data without invoking a shell and refuses ambiguous values', () => {
    expect(
      parseServiceEnvironment(
        'HOME=/home/ubuntu "OTHER=private value" AWS_PROFILE=openclaw-instance-role',
      ),
    ).toEqual({
      HOME: '/home/ubuntu',
      OTHER: 'private value',
      AWS_PROFILE: 'openclaw-instance-role',
    });
    expect(parseServiceEnvironment('NAME=$(must-not-execute)')).toEqual({
      NAME: '$(must-not-execute)',
    });
    expect(() => parseServiceEnvironment('AWS_PROFILE=one AWS_PROFILE=two')).toThrow(/Ambiguous/);
    expect(() => parseServiceEnvironment('AWS_PROFILE="unterminated')).toThrow(/quoting/);
  });
});
