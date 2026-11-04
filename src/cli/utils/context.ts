import type { OpenClawConfig } from '../types/index.js';
import { resolveConfig } from './config-store.js';
import { applyAwsProfile, requireAwsCredentials } from './aws-validation.js';
import { getAwsProfileEnvironment } from './aws-profile.js';

export interface CommandContext {
  name: string;
  config: OpenClawConfig;
  configPath: string;
  awsEnv: Record<string, string | undefined>;
}

export interface CommandContextOptions {
  name?: string;
  requireCredentials?: boolean;
}

export async function buildCommandContext(
  options: CommandContextOptions = {},
): Promise<CommandContext> {
  const { name, config, configPath } = resolveConfig({ name: options.name });

  if (options.requireCredentials !== false) {
    await requireAwsCredentials(config);
  } else {
    applyAwsProfile(config.aws.profile);
  }

  return {
    name,
    config,
    configPath,
    awsEnv: buildAwsEnv(config),
  };
}

export function buildAwsEnv(config: OpenClawConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...getAwsProfileEnvironment(config.aws.profile),
    AWS_REGION: config.aws.region,
  };

  return env;
}
