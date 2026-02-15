import fs from 'fs';
import path from 'path';
import {
  getConfigRoot,
  getConfigsDir,
  getConfigPathByName,
  getCurrentPath,
  getOutputsDir,
  getOutputsPathByName,
  loadConfigByName
} from './config.js';
import { ConfigError } from './errors.js';
import type { OpenClawConfig } from '../types/index.js';

export interface ResolvedConfig {
  name: string;
  config: OpenClawConfig;
  configPath: string;
  configRoot: string;
}

export interface ConfigResolveOptions {
  name?: string;
}

function ensureDirs(): void {
  const root = getConfigRoot();
  const configsDir = getConfigsDir();
  const outputsDir = getOutputsDir();

  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });
  if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
}

export function listConfigNames(): string[] {
  ensureDirs();
  const configsDir = getConfigsDir();
  return fs.readdirSync(configsDir)
    .filter(file => file.endsWith('.json'))
    .map(file => path.basename(file, '.json'))
    .sort();
}

export function getCurrentName(): string | null {
  const currentPath = getCurrentPath();
  if (!fs.existsSync(currentPath)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
    return typeof content?.name === 'string' ? content.name : null;
  } catch {
    return null;
  }
}

export function clearCurrentName(): void {
  const currentPath = getCurrentPath();
  if (fs.existsSync(currentPath)) {
    fs.unlinkSync(currentPath);
  }
}

export function setCurrentName(name: string): void {
  ensureDirs();
  fs.writeFileSync(getCurrentPath(), JSON.stringify({ name }, null, 2));
}

export function resolveConfig(options: ConfigResolveOptions = {}): ResolvedConfig {
  ensureDirs();
  const available = listConfigNames();
  let name = options.name;

  if (!name) {
    const current = getCurrentName();
    if (current) {
      name = current;
    } else if (available.length === 1) {
      name = available[0];
      setCurrentName(name);
    }
  }

  if (!name) {
    throw new ConfigError('No config selected', [
      'List configs: openclaw-aws list',
      'Select one: openclaw-aws use <name>',
      'Create one: openclaw-aws init --name <name>'
    ]);
  }

  if (!available.includes(name)) {
    throw new ConfigError(`Config not found: ${name}`, [
      'Create a deployment: openclaw-aws init --name <name>',
      'List configs: openclaw-aws list'
    ]);
  }

  return {
    name,
    config: loadConfigByName(name),
    configPath: getConfigPathByName(name),
    configRoot: getConfigRoot()
  };
}

export function resolveOutputsPath(name: string): string {
  ensureDirs();
  return getOutputsPathByName(name);
}
