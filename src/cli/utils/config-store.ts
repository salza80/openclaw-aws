import path from 'path';
import { getConfigDir, getConfigPath, loadConfig } from './config.js';
import type { OpenClawConfig } from '../types/index.js';

export interface ResolvedConfig {
  config: OpenClawConfig;
  configPath: string;
  configDir: string;
}

export interface ConfigResolveOptions {
  configPath?: string;
}

export function resolveConfig(options: ConfigResolveOptions = {}): ResolvedConfig {
  const configPath = getConfigPath(options.configPath);
  const config = loadConfig(options.configPath);
  const configDir = getConfigDir(options.configPath);

  return {
    config,
    configPath,
    configDir
  };
}

export function resolveConfigDir(configPath?: string): string {
  return getConfigDir(configPath);
}

export function resolveOutputsPath(configPath?: string): string {
  return path.join(resolveConfigDir(configPath), 'outputs.json');
}
