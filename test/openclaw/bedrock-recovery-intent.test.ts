import { describe, expect, it } from 'vitest';
import {
  BEDROCK_PLUGIN,
  bedrockConfigurationPatch,
} from '../../src/openclaw/bedrock-configuration.js';
import {
  parseBedrockRecoveryIntent,
  savedBedrockRecoveryIntent,
} from '../../src/openclaw/bedrock-recovery-intent.js';
import { parseCapturedBackup } from '../../src/openclaw/backup-contract.js';
import { backupReceipt } from '../helpers/fixtures/backup.js';
const settings = {
  home: '/home/ubuntu',
  deploymentRegion: 'eu-central-1',
  inferenceRegion: 'us-east-1',
};
function config() {
  const patch = bedrockConfigurationPatch({ ...settings, config: {} });
  return {
    ...patch,
    agents: {
      defaults: {
        model: {
          primary: 'openrouter/base',
          fallbacks: ['fallback-alias', 'amazon-bedrock/provider.second'],
        },
        models: {
          'amazon-bedrock/provider.fallback': { alias: 'fallback-alias' },
          'amazon-bedrock/provider.unused': {},
        },
      },
      ownership: 'explicit',
      entries: {
        researcher: {
          model: { primary: 'worker-alias' },
          models: { 'amazon-bedrock/provider.agent': { alias: 'worker-alias' } },
        },
        reviewer: { model: 'openrouter/reviewer' },
      },
    },
  };
}
describe('portable Bedrock connection intent', () => {
  it('covers actual defaults, agents, inherited fallbacks and scoped aliases without adopting unused grants or secrets', () => {
    const source = config();
    const before = structuredClone(source);
    const intent = savedBedrockRecoveryIntent({
      ...settings,
      config: source,
      environment: { OPENROUTER_API_KEY: 'private-source-key' },
      members: [{ id: 'extra', model: 'amazon-bedrock/provider.effective' }],
      sessionModels: ['amazon-bedrock/provider.saved-session'],
    });
    expect(intent).toEqual({
      authMode: 'instance-role',
      inferenceRegion: 'us-east-1',
      plugin: BEDROCK_PLUGIN,
      models: [
        'amazon-bedrock/provider.agent',
        'amazon-bedrock/provider.effective',
        'amazon-bedrock/provider.fallback',
        'amazon-bedrock/provider.saved-session',
        'amazon-bedrock/provider.second',
      ],
    });
    expect(source).toEqual(before);
    expect(JSON.stringify(intent)).not.toContain('private-source-key');
    expect(JSON.stringify(intent)).not.toContain('unused');
  });
  it('retains a configured optional connection even when all current models use OpenRouter', () => {
    expect(
      savedBedrockRecoveryIntent({
        ...settings,
        config: bedrockConfigurationPatch({ ...settings, config: {} }),
      })?.models,
    ).toEqual([]);
    expect(
      savedBedrockRecoveryIntent({
        ...settings,
        config: { agents: { defaults: { model: 'openrouter/base' } } },
      }),
    ).toBeUndefined();
    expect(
      savedBedrockRecoveryIntent({
        ...settings,
        config: { plugins: { entries: { 'amazon-bedrock': { enabled: true, config: {} } } } },
      }),
    ).toBeUndefined();
  });
  it('includes canonical explicit-agent entries and their scoped fallback aliases', () => {
    const source = config();
    Object.assign(source.agents, {
      ownership: 'explicit',
      entries: {
        researcher: {
          model: { primary: 'openrouter/main', fallbacks: ['backup-alias'] },
          models: { 'amazon-bedrock/provider.scoped-fallback': { alias: 'backup-alias' } },
        },
      },
    });
    expect(savedBedrockRecoveryIntent({ ...settings, config: source })?.models).toContain(
      'amazon-bedrock/provider.scoped-fallback',
    );
  });
  it('refuses unknown/non-role Bedrock settings and foreign identity without publishing credential values', () => {
    expect(() =>
      savedBedrockRecoveryIntent({
        ...settings,
        config: { agents: { defaults: { model: 'amazon-bedrock/model' } } },
      }),
    ).toThrow(/region is unavailable/);
    const source = config();
    (source.models as { providers: Record<string, unknown> }).providers['amazon-bedrock'] = {
      apiKey: 'private-saved-key',
    };
    expect(() => savedBedrockRecoveryIntent({ ...settings, config: source })).toThrow(
      /conflicting authentication/,
    );
    try {
      savedBedrockRecoveryIntent({
        ...settings,
        config: config(),
        environment: { AWS_ACCESS_KEY_ID: 'private-operator-key' },
      });
      expect.fail('foreign credentials must be refused');
    } catch (error) {
      expect((error as Error).message).toContain('AWS_ACCESS_KEY_ID');
      expect((error as Error).message).not.toContain('private-operator-key');
    }
  });
  it('refuses ambiguous Bedrock aliases rather than authorizing a guessed route', () => {
    const source = config();
    Object.assign(source.agents.defaults.models, {
      'openrouter/other': { alias: 'fallback-alias' },
    });
    expect(() => savedBedrockRecoveryIntent({ ...settings, config: source })).toThrow(/ambiguous/);
  });
  it('validates saved connection metadata without accepting secret fields', () => {
    const intent = savedBedrockRecoveryIntent({ ...settings, config: config() })!;
    const capture = structuredClone(backupReceipt.capture);
    capture.credentials.bedrock = intent;
    expect(parseCapturedBackup(capture, backupReceipt.job).credentials.bedrock).toEqual(intent);
    const invalid = { ...intent, secret: 'private-key' };
    expect(() =>
      parseCapturedBackup(
        { ...capture, credentials: { ...capture.credentials, bedrock: invalid } },
        backupReceipt.job,
      ),
    ).toThrow(/intent/);
  });
  it.each([
    { plugin: { ...BEDROCK_PLUGIN, integrity: 'changed' } },
    { models: ['openrouter/model'] },
    { models: ['amazon-bedrock/model', 'amazon-bedrock/model'] },
    { inferenceRegion: 'not-a-region' },
    { authMode: 'api-key' },
  ])('refuses an unsupported saved plan %j', (override) => {
    expect(() =>
      parseBedrockRecoveryIntent({
        ...savedBedrockRecoveryIntent({ ...settings, config: config() }),
        ...override,
      }),
    ).toThrow();
  });
});
