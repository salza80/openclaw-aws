import path from 'path';
import fs from 'fs';
import type { OpenClawConfig } from '../types/index.js';
import { ConfigError } from './errors.js';
import { validateConfig, validateConfigStructure } from './config-validation.js';

const CONFIG_ROOT = '.openclaw-aws';
const CONFIGS_DIR = 'configs';
const OUTPUTS_DIR = 'outputs';
const CURRENT_FILE = 'current.json';

export function getConfigRoot(): string {
  return path.join(process.cwd(), CONFIG_ROOT);
}

export function getConfigsDir(): string {
  return path.join(getConfigRoot(), CONFIGS_DIR);
}

export function getConfigPathByName(name: string): string {
  return path.join(getConfigsDir(), `${name}.json`);
}

export function getOutputsDir(): string {
  return path.join(getConfigRoot(), OUTPUTS_DIR);
}

export function getOutputsPathByName(name: string): string {
  return path.join(getOutputsDir(), `${name}.json`);
}

export function getCurrentPath(): string {
  return path.join(getConfigRoot(), CURRENT_FILE);
}

export function loadConfigByName(name: string): OpenClawConfig {
  const configFile = getConfigPathByName(name);
  
  if (!fs.existsSync(configFile)) {
    throw new ConfigError(
      `Config file not found: ${configFile}`,
      ['Run: openclaw-aws init']
    );
  }

  let config: unknown;
  try {
    const content = fs.readFileSync(configFile, 'utf-8');
    config = JSON.parse(content);
  } catch {
    throw new ConfigError(
      `Failed to parse config file: ${configFile}`,
      [
        'Check the file is valid JSON',
        'Run: openclaw-aws init (to recreate)'
      ]
    );
  }

  // Validate structure
  if (!validateConfigStructure(config)) {
    throw new ConfigError(
      'Invalid configuration structure',
      ['Run: openclaw-aws init (to recreate configuration)']
    );
  }

  // Validate contents
  validateConfig(config);

  return config;
}

export function saveConfigByName(config: OpenClawConfig, name: string): void {
  // Validate before saving
  validateConfig(config);

  const configDir = getConfigsDir();
  const configFile = getConfigPathByName(name);

  // Create directory if it doesn't exist
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

export function configExistsByName(name: string): boolean {
  return fs.existsSync(getConfigPathByName(name));
}

export function loadOutputsByName(name: string): Record<string, unknown> | null {
  const outputsPath = getOutputsPathByName(name);
  if (!fs.existsSync(outputsPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(outputsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
