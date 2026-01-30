import path from 'path';
import fs from 'fs';
import type { OpenClawConfig } from '../types/index.js';
import { ConfigError } from './errors.js';
import { validateConfig, validateConfigStructure } from './config-validation.js';

const CONFIG_DIR = '.openclaw-aws';
const CONFIG_FILE = 'config.json';

export function getConfigPath(configPath?: string): string {
  if (configPath) {
    return path.resolve(configPath);
  }
  return path.join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
}

export function getConfigDir(): string {
  return path.join(process.cwd(), CONFIG_DIR);
}

export function loadConfig(configPath?: string): OpenClawConfig {
  const configFile = getConfigPath(configPath);
  
  if (!fs.existsSync(configFile)) {
    throw new ConfigError(
      `Config file not found: ${configFile}`,
      ['Run: openclaw-aws init']
    );
  }

  let config: any;
  try {
    const content = fs.readFileSync(configFile, 'utf-8');
    config = JSON.parse(content);
  } catch (error) {
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

export function saveConfig(config: OpenClawConfig, configPath?: string): void {
  // Validate before saving
  validateConfig(config);

  const configDir = getConfigDir();
  const configFile = getConfigPath(configPath);

  // Create directory if it doesn't exist
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

export function configExists(configPath?: string): boolean {
  const configFile = getConfigPath(configPath);
  return fs.existsSync(configFile);
}

export function getOutputsPath(): string {
  return path.join(getConfigDir(), 'outputs.json');
}

export function loadOutputs(): Record<string, any> | null {
  const outputsPath = getOutputsPath();
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
