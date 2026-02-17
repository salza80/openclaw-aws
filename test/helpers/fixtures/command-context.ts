import type { OpenClawConfig } from '../../../src/cli/types/index.js';
import type { CommandContext } from '../../../src/cli/utils/context.js';

const baseConfig: OpenClawConfig = {
  version: '1.0',
  aws: { region: 'us-east-1' },
  network: { useDefaultVpc: true },
  instance: { name: 'openclaw-alpha', type: 't3.micro' },
  features: { cloudWatchLogs: true },
  stack: { name: 'OpenclawStack-alpha' },
  openclaw: { apiProvider: 'anthropic-api-key' },
};

export function makeCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const configOverrides = (overrides.config ?? {}) as Partial<OpenClawConfig>;
  return {
    name: 'alpha',
    configPath: '/tmp/alpha.json',
    config: {
      ...baseConfig,
      ...configOverrides,
      aws: { ...baseConfig.aws, ...configOverrides.aws },
      network: { ...baseConfig.network, ...configOverrides.network },
      instance: { ...baseConfig.instance, ...configOverrides.instance },
      features: { ...baseConfig.features, ...configOverrides.features },
      stack: { ...baseConfig.stack, ...configOverrides.stack },
      openclaw: {
        ...baseConfig.openclaw,
        ...(configOverrides.openclaw ?? {}),
      },
    },
    awsEnv: {
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'test',
      ...(overrides.awsEnv ?? {}),
    },
    ...overrides,
  };
}
