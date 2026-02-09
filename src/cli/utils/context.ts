import type { OpenClawConfig } from '../types/index.js';
import { resolveConfig } from './config-store.js';
import { applyAwsProfile, requireAwsCredentials } from './aws-validation.js';

export interface CommandContext {
  config: OpenClawConfig;
  configPath: string;
  configDir: string;
  awsEnv: Record<string, string | undefined>;
}

export interface CommandContextOptions {
  configPath?: string;
  requireCredentials?: boolean;
}

export async function buildCommandContext(
  options: CommandContextOptions = {}
): Promise<CommandContext> {
  const { config, configPath, configDir } = resolveConfig({ configPath: options.configPath });

  if (options.requireCredentials !== false) {
    await requireAwsCredentials(config);
  } else {
    applyAwsProfile(config.aws.profile);
  }

  return {
    config,
    configPath,
    configDir,
    awsEnv: buildAwsEnv(config)
  };
}

export function buildAwsEnv(config: OpenClawConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AWS_REGION: config.aws.region
  };

  if (config.aws.profile) {
    env.AWS_PROFILE = config.aws.profile;
  }

  return env;
}
