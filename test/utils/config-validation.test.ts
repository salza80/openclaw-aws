import { describe, it, expect } from 'vitest';
import { validateConfig, validateConfigStructure } from '../../src/cli/utils/config-validation.js';
import { ValidationError } from '../../src/cli/utils/errors.js';

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

function expectValidationError(config: unknown, expectedMessage: string): void {
  expect(() => validateConfig(config as unknown as typeof validConfig)).toThrow(ValidationError);
  expect(() => validateConfig(config as unknown as typeof validConfig)).toThrow(expectedMessage);
}

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

  it('throws when version is invalid', () => {
    expectValidationError(
      { ...validConfig, version: '2.0' },
      'Invalid or missing config version (expected: "1.0")',
    );
  });

  it('throws when aws configuration is missing', () => {
    expectValidationError({ ...validConfig, aws: undefined }, 'Missing aws configuration');
  });

  it('throws when aws.region is missing', () => {
    expectValidationError({ ...validConfig, aws: { region: '' } }, 'Missing aws.region');
  });

  it('throws when instance configuration is missing', () => {
    expectValidationError({ ...validConfig, instance: undefined }, 'Missing instance configuration');
  });

  it('throws when instance.type is missing', () => {
    expectValidationError(
      { ...validConfig, instance: { ...validConfig.instance, type: '' } },
      'Missing instance.type',
    );
  });

  it('throws when instance.type format is invalid', () => {
    expectValidationError(
      { ...validConfig, instance: { ...validConfig.instance, type: 'invalid-type' } },
      'Invalid instance.type format (e.g., t3.micro)',
    );
  });

  it('throws when instance.name is missing', () => {
    expectValidationError(
      { ...validConfig, instance: { ...validConfig.instance, name: '' } },
      'Missing instance.name',
    );
  });

  it('throws when instance.name contains invalid characters', () => {
    expectValidationError(
      { ...validConfig, instance: { ...validConfig.instance, name: 'invalid name' } },
      'instance.name must contain only letters, numbers, and hyphens',
    );
  });

  it('throws when instance.name exceeds max length', () => {
    expectValidationError(
      { ...validConfig, instance: { ...validConfig.instance, name: 'a'.repeat(64) } },
      'instance.name must be 63 characters or less',
    );
  });

  it('throws when network configuration is missing', () => {
    expectValidationError({ ...validConfig, network: undefined }, 'Missing network configuration');
  });

  it('throws when network.useDefaultVpc is not a boolean', () => {
    expectValidationError(
      { ...validConfig, network: { useDefaultVpc: 'true' } },
      'network.useDefaultVpc must be a boolean',
    );
  });

  it('throws when features configuration is missing', () => {
    expectValidationError({ ...validConfig, features: undefined }, 'Missing features configuration');
  });

  it('throws when features.cloudWatchLogs is not a boolean', () => {
    expectValidationError(
      { ...validConfig, features: { cloudWatchLogs: 'true' } },
      'features.cloudWatchLogs must be a boolean',
    );
  });

  it('throws when stack configuration is missing', () => {
    expectValidationError({ ...validConfig, stack: undefined }, 'Missing stack configuration');
  });

  it('throws when stack.name is missing', () => {
    expectValidationError({ ...validConfig, stack: { name: '' } }, 'Missing stack.name');
  });

  it('throws when stack.name format is invalid', () => {
    expectValidationError(
      { ...validConfig, stack: { name: '1invalid-stack-name' } },
      'stack.name must start with a letter and contain only letters, numbers, and hyphens',
    );
  });

  it('throws when stack.name exceeds max length', () => {
    expectValidationError(
      { ...validConfig, stack: { name: `A${'a'.repeat(128)}` } },
      'stack.name must be 128 characters or less',
    );
  });
});
