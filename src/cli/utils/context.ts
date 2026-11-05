import { assertDeploymentTarget } from '../../operations/state.js';
import type { OpenClawConfig } from '../types/index.js';
import { resolveConfig } from './config-store.js';
import { resolveAwsTarget, type AwsTarget } from '../../aws/target.js';

export interface CommandContext {
  name: string;
  config: OpenClawConfig;
  configPath: string;
  target: AwsTarget;
  awsEnv: Record<string, string | undefined>;
}

export interface CommandContextOptions {
  name?: string;
}

export async function buildCommandContext(
  options: CommandContextOptions = {},
): Promise<CommandContext> {
  const { name, config, configPath } = resolveConfig({ name: options.name });

  const target = await resolveAwsTarget(config.aws);

  const context = {
    name,
    config,
    configPath,
    target,
    awsEnv: await target.environment(),
  };
  assertDeploymentTarget(context);
  return context;
}
