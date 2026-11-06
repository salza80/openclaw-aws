import { describe, expect, it } from 'vitest';
import { API_PROVIDERS } from '../../src/cli/constants.js';
import {
  freshProviderCredentials,
  initialModelConnection,
  isApiKeyProvider,
} from '../../src/openclaw/connections.js';
import { getApiKeyEnvVar, getApiKeyParamName } from '../../src/cli/utils/api-keys.js';
import {
  validateConfig,
  validateProvisioningConfig,
} from '../../src/cli/utils/config-validation.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
import type { ApiKeyProvider } from '../../src/cli/types/index.js';
describe('initial model connections', () => {
  it('keeps every existing v1 API-key provider and omitted default compatible', () => {
    expect(initialModelConnection({})).toEqual({
      provider: 'anthropic-api-key',
      authMode: 'api-key',
    });
    for (const { value } of API_PROVIDERS) {
      const config = makeCommandContext().config;
      config.openclaw = { apiProvider: value };
      expect(() => validateConfig(config)).not.toThrow();
      expect(initialModelConnection(config)).toEqual({ provider: value, authMode: 'api-key' });
      expect(isApiKeyProvider(value)).toBe(true);
      expect(freshProviderCredentials(value, 'fixture-private-key')).toEqual({
        apiProvider: value,
        apiKey: 'fixture-private-key',
      });
    }
  });
  it('represents inference region and instance-role auth without any model-key input or namespace', () => {
    const config = makeCommandContext().config;
    config.openclaw = {
      apiProvider: 'amazon-bedrock',
      authMode: 'instance-role',
      bedrock: { region: 'eu-central-1' },
      model: 'amazon-bedrock/example-profile',
    };
    expect(() => validateProvisioningConfig(config)).not.toThrow();
    expect(initialModelConnection(config)).toEqual({
      provider: 'amazon-bedrock',
      authMode: 'instance-role',
      region: 'eu-central-1',
    });
    expect(config.aws.region).toBe('us-east-1');
    expect(freshProviderCredentials('amazon-bedrock')).toEqual({ apiProvider: 'amazon-bedrock' });
    expect(() => freshProviderCredentials('amazon-bedrock', 'unused-secret')).toThrow(
      /cannot receive/,
    );
    expect(() => getApiKeyEnvVar('amazon-bedrock' as ApiKeyProvider)).toThrow(/do not have/);
    expect(() => getApiKeyParamName('test', 'amazon-bedrock' as ApiKeyProvider)).toThrow(
      /do not have/,
    );
  });
  it('refuses ambiguous authentication and preserves lifecycle access without requiring a new initial model', () => {
    const config = makeCommandContext().config;
    for (const setup of [
      { apiProvider: 'amazon-bedrock' },
      { apiProvider: 'amazon-bedrock', authMode: 'api-key', bedrock: { region: 'eu-central-1' } },
      { apiProvider: 'openrouter-api-key', authMode: 'instance-role' },
      { apiProvider: 'openrouter-api-key', bedrock: { region: 'eu-central-1' } },
    ])
      expect(() => initialModelConnection({ openclaw: setup } as typeof config)).toThrow();
    config.openclaw = {
      apiProvider: 'amazon-bedrock',
      authMode: 'instance-role',
      bedrock: { region: 'eu-central-1' },
    };
    expect(() => validateConfig(config)).not.toThrow();
    expect(() => validateProvisioningConfig(config)).toThrow(/explicit amazon-bedrock/);
    config.openclaw.model = `amazon-bedrock/arn:aws:bedrock:eu-central-1:123456789012:inference-profile/${'a'.repeat(240)}`;
    expect(() => validateProvisioningConfig(config)).not.toThrow();
  });
});
