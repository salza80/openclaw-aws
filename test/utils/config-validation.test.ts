import { describe, it, expect } from 'vitest';
import { validateConfig, validateConfigStructure } from '../../src/cli/utils/config-validation.js';

const validConfig = {
  version: '1.0',
  aws: {
    region: 'us-east-1',
  },
  network: {
    useDefaultVpc: true,
  },
  instance: {
    type: 't3.micro',
    name: 'openclaw-my-openclaw-bot',
  },
  features: {
    cloudWatchLogs: true,
  },
  stack: {
    name: 'OpenclawStack-my-openclaw-bot',
  },
};

describe('config-validation', () => {
  it('accepts valid config structure', () => {
    expect(validateConfigStructure(validConfig)).toBe(true);
  });

  it('rejects invalid config structure', () => {
    expect(validateConfigStructure({})).toBe(false);
  });

  it('throws on invalid config values', () => {
    const badConfig = { ...validConfig, aws: { region: 'bad-region' } };
    expect(() => validateConfig(badConfig as unknown as typeof validConfig)).toThrow(
      'Configuration validation failed',
    );
  });
});
