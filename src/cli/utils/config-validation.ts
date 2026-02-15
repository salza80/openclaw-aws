import type { OpenClawConfig } from '../types/index.js';
import { ValidationError } from './errors.js';

export function validateConfig(config: OpenClawConfig): void {
  const errors: string[] = [];

  // Validate version
  if (!config.version || config.version !== '1.0') {
    errors.push('Invalid or missing config version (expected: "1.0")');
  }

  // Validate AWS config
  if (!config.aws) {
    errors.push('Missing aws configuration');
  } else {
    if (!config.aws.region) {
      errors.push('Missing aws.region');
    } else if (!/^[a-z]{2}-[a-z]+-\d+$/.test(config.aws.region)) {
      errors.push('Invalid aws.region format (e.g., us-east-1)');
    }
  }

  // Validate instance config
  if (!config.instance) {
    errors.push('Missing instance configuration');
  } else {
    if (!config.instance.type) {
      errors.push('Missing instance.type');
    } else if (
      !/^[a-z][0-9][a-z]?\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/.test(
        config.instance.type,
      )
    ) {
      errors.push('Invalid instance.type format (e.g., t3.micro)');
    }

    if (!config.instance.name) {
      errors.push('Missing instance.name');
    } else if (!/^[a-zA-Z0-9-]+$/.test(config.instance.name)) {
      errors.push('instance.name must contain only letters, numbers, and hyphens');
    } else if (config.instance.name.length > 63) {
      errors.push('instance.name must be 63 characters or less');
    }
  }

  // Validate network config
  if (!config.network) {
    errors.push('Missing network configuration');
  } else if (typeof config.network.useDefaultVpc !== 'boolean') {
    errors.push('network.useDefaultVpc must be a boolean');
  }

  // Validate features
  if (!config.features) {
    errors.push('Missing features configuration');
  } else {
    if (typeof config.features.cloudWatchLogs !== 'boolean') {
      errors.push('features.cloudWatchLogs must be a boolean');
    }
  }

  // Validate stack config
  if (!config.stack) {
    errors.push('Missing stack configuration');
  } else {
    if (!config.stack.name) {
      errors.push('Missing stack.name');
    } else if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(config.stack.name)) {
      errors.push(
        'stack.name must start with a letter and contain only letters, numbers, and hyphens',
      );
    } else if (config.stack.name.length > 128) {
      errors.push('stack.name must be 128 characters or less');
    }
  }

  if (errors.length > 0) {
    throw new ValidationError('Configuration validation failed:\n  ' + errors.join('\n  '), [
      'Run: openclaw-aws init (to recreate configuration)',
      'Or manually fix the active config in .openclaw-aws/configs/<name>.json (see .openclaw-aws/current.json)',
    ]);
  }
}

export function validateConfigStructure(obj: unknown): obj is OpenClawConfig {
  return !!(
    obj &&
    typeof obj === 'object' &&
    'version' in obj &&
    'aws' in obj &&
    'instance' in obj &&
    'network' in obj &&
    'features' in obj &&
    'stack' in obj
  );
}
