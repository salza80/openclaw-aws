import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bedrockConfigurationPatch,
  configureNativeBedrock,
  type BedrockConfigurationEvent,
} from '../../src/openclaw/bedrock-configuration.js';
import { ModelControlError } from '../../src/openclaw/model-control.js';

const secret = 'private-openrouter-credential';
const options = {
  home: '/home/ubuntu',
  deploymentRegion: 'eu-central-1',
  inferenceRegion: 'eu-central-1',
  expectedHash: 'revision-0',
  allowRestart: true,
};
let config: Record<string, unknown>;
let previous: Record<string, unknown>;
let revision: number;
let events: BedrockConfigurationEvent[];
let client: {
  call: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
};
function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ??= {};
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else target[key] = structuredClone(value);
  }
}
const record = async (event: BedrockConfigurationEvent) => {
  events.push(event);
};
const run = () => configureNativeBedrock(client, { ...options, record });
beforeEach(() => {
  revision = 0;
  events = [];
  config = {
    plugins: { allow: ['other'], entries: { other: { enabled: true } } },
    models: { providers: { openrouter: { apiKey: secret, models: [{ id: 'old' }] } } },
    auth: { profiles: { 'openrouter:default': { provider: 'openrouter', mode: 'api_key' } } },
    agents: {
      defaults: { model: { primary: 'openrouter/old', fallbacks: ['openrouter/fallback'] } },
      entries: { reviewer: { model: 'openrouter/reviewer' } },
    },
    channels: { telegram: { botToken: secret } },
  };
  previous = structuredClone(config);
  client = {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'config.get')
        return { valid: true, hash: `revision-${revision}`, config: structuredClone(config) };
      if (method === 'config.patch') {
        expect(params.baseHash).toBe(`revision-${revision}`);
        merge(config, JSON.parse(params.raw as string));
        revision++;
        return { ok: true };
      }
      throw Error(secret);
    }),
    restart: vi.fn(async () => {}),
    health: vi.fn(async () => {}),
  };
});
describe('native Bedrock provider configuration', () => {
  it('enables role auth and native discovery while preserving existing providers, agents, credentials and plugin policy', async () => {
    expect(await run()).toMatchObject({
      phase: 'complete',
      restarted: true,
      inferenceVerified: false,
    });
    expect(config).toMatchObject({
      env: {
        vars: {
          AWS_PROFILE: 'openclaw-instance-role',
          AWS_CONFIG_FILE: '/home/ubuntu/.openclaw-aws/aws/config',
          AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
          AWS_EC2_METADATA_V1_DISABLED: 'true',
        },
      },
      models: previous.models,
      auth: previous.auth,
      agents: previous.agents,
      channels: previous.channels,
      plugins: { entries: { other: { enabled: true } } },
    });
    expect(config).toMatchObject({
      plugins: {
        allow: ['other', 'amazon-bedrock'],
        entries: {
          'amazon-bedrock': {
            enabled: true,
            config: { discovery: { enabled: true, region: 'eu-central-1' } },
          },
        },
      },
      models: {
        providers: {
          'amazon-bedrock': {
            api: 'bedrock-converse-stream',
            auth: 'aws-sdk',
            baseUrl: 'https://bedrock-runtime.eu-central-1.amazonaws.com',
            models: [],
          },
        },
      },
      auth: {
        profiles: {
          'amazon-bedrock:instance-role': { provider: 'amazon-bedrock', mode: 'aws-sdk' },
        },
      },
    });
    expect(config.agents).toEqual(previous.agents);
    expect(events.map((event) => event.phase)).toEqual(['intent', 'acknowledged', 'complete']);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(client.restart).toHaveBeenCalledTimes(1);
    expect(
      client.call.mock.calls.every(([method]) => ['config.get', 'config.patch'].includes(method)),
    ).toBe(true);
  });
  it('refuses unapproved restart and stale configuration before recording intent or changing anything', async () => {
    await expect(
      configureNativeBedrock(client, { ...options, allowRestart: false, record }),
    ).rejects.toMatchObject({ outcome: 'unchanged' });
    revision++;
    await expect(run()).rejects.toMatchObject({ outcome: 'conflict' });
    expect(events).toEqual([]);
    expect(config).toEqual(previous);
    expect(client.restart).not.toHaveBeenCalled();
  });
  it('restores only its owned settings after activation failure and retains unrelated concurrent changes', async () => {
    client.health.mockImplementationOnce(async () => {
      config.newNativeSetting = { unrelated: true };
      throw Error(secret);
    });
    await expect(run()).rejects.toMatchObject({ outcome: 'rolled-back' });
    expect(config).toEqual({ ...previous, newNativeSetting: { unrelated: true } });
    expect(events.map((event) => event.phase)).toEqual(['intent', 'acknowledged', 'rolled-back']);
    expect(client.restart).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
  it('never retries or rolls back a write whose acknowledgement was lost', async () => {
    const original = client.call.getMockImplementation()!;
    client.call.mockImplementation(async (...args: [string, Record<string, unknown>]) => {
      const result = await original(...args);
      if (args[0] === 'config.patch') throw Error(secret);
      return result;
    });
    await expect(run()).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(events.map((event) => event.phase)).toEqual(['intent', 'uncertain']);
    expect(client.call.mock.calls.filter(([method]) => method === 'config.patch')).toHaveLength(1);
    expect(client.restart).not.toHaveBeenCalled();
  });
  it('does not delete newly added sibling settings inside a formerly absent parent during rollback', async () => {
    client.health.mockImplementationOnce(async () => {
      merge(config, {
        plugins: {
          entries: {
            'amazon-bedrock': {
              config: { guardrail: { guardrailIdentifier: 'concurrent-native-setting' } },
            },
          },
        },
      });
      throw Error(secret);
    });
    await expect(run()).rejects.toMatchObject({ outcome: 'rolled-back' });
    expect(config).toMatchObject({
      plugins: {
        entries: {
          'amazon-bedrock': {
            config: { guardrail: { guardrailIdentifier: 'concurrent-native-setting' } },
          },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('"aws-sdk"');
    expect(config.agents).toEqual(previous.agents);
  });
  it('retains uncertainty if another writer changes the owned provider or rollback acknowledgement is lost', async () => {
    client.health.mockImplementationOnce(async () => {
      merge(config, { plugins: { entries: { 'amazon-bedrock': { enabled: false } } } });
      throw Error(secret);
    });
    await expect(run()).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(client.call.mock.calls.filter(([method]) => method === 'config.patch')).toHaveLength(1);
    expect(events.at(-1)?.phase).toBe('uncertain');
  });
  it('preserves explicit model definitions, guardrails and discovery filters, and supports partition-specific AWS endpoints', () => {
    merge(config, {
      plugins: {
        entries: {
          'amazon-bedrock': {
            config: {
              guardrail: { guardrailIdentifier: 'saved' },
              discovery: { providerFilter: ['anthropic'] },
            },
          },
        },
      },
      models: { providers: { 'amazon-bedrock': { models: [{ id: 'explicit' }] } } },
    });
    const patch = bedrockConfigurationPatch({ ...options, config });
    merge(config, patch);
    expect(config).toMatchObject({
      plugins: {
        entries: {
          'amazon-bedrock': {
            config: {
              guardrail: { guardrailIdentifier: 'saved' },
              discovery: { providerFilter: ['anthropic'] },
            },
          },
        },
      },
      models: { providers: { 'amazon-bedrock': { models: [{ id: 'explicit' }] } } },
    });
    const china = bedrockConfigurationPatch({
      ...options,
      config: {},
      inferenceRegion: 'cn-north-1',
    });
    expect(JSON.stringify(china)).toContain('https://bedrock-runtime.cn-north-1.amazonaws.com.cn');
  });
  it.each([
    { plugins: { enabled: false } },
    { plugins: { deny: ['amazon-bedrock'] } },
    { env: { vars: { AWS_ACCESS_KEY_ID: secret } } },
    { env: { AWS_PROFILE: 'operator' } },
    { models: { providers: { 'amazon-bedrock': { apiKey: secret } } } },
    { models: { providers: { 'amazon-bedrock': { headers: { Authorization: secret } } } } },
    { models: { providers: { 'amazon-bedrock': { baseUrl: 'https://other.example' } } } },
    {
      plugins: {
        entries: { 'amazon-bedrock': { config: { discovery: { region: 'us-east-1' } } } },
      },
    },
  ])('refuses conflicting saved identity/endpoint/region inputs privately: %j', (saved) => {
    expect(() => bedrockConfigurationPatch({ ...options, config: saved })).toThrow();
    try {
      bedrockConfigurationPatch({ ...options, config: saved });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
      expect(error).not.toBeInstanceOf(ModelControlError);
    }
  });
});
