import fs from 'fs';
import path from 'path';
import { API_PROVIDERS } from '../constants.js';
import { API_KEY_PLACEHOLDER, getApiKeyEnvVar } from './api-keys.js';
import { ValidationError } from './errors.js';

export interface EnsureEnvFilesResult {
  envPath: string;
  envExamplePath: string;
  createdEnv: boolean;
  createdEnvExample: boolean;
}

function listApiKeyEnvVars(): string[] {
  return Array.from(new Set(API_PROVIDERS.map((provider) => getApiKeyEnvVar(provider.value))));
}

export function buildEnvTemplate(): string {
  const envVars = listApiKeyEnvVars();
  const lines = [
    '# OpenClaw AWS API keys',
    '# Replace only the provider key used by your config.',
    ...envVars.map((envVar) => `${envVar}=${API_KEY_PLACEHOLDER}`),
    '',
  ];
  return lines.join('\n');
}

function ensureRegularFileOrMissing(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  if (!fs.statSync(filePath).isFile()) {
    throw new ValidationError(`Expected a file but found a directory: ${filePath}`, [
      'Remove or rename the directory and rerun: openclaw-aws init',
    ]);
  }
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    return false;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

export function ensureEnvFiles(baseDir: string): EnsureEnvFilesResult {
  const envPath = path.join(baseDir, '.env');
  const envExamplePath = path.join(baseDir, '.env.example');

  ensureRegularFileOrMissing(envPath);
  ensureRegularFileOrMissing(envExamplePath);

  const template = buildEnvTemplate();
  const createdEnvExample = writeIfMissing(envExamplePath, template);
  const envSeed = fs.readFileSync(envExamplePath, 'utf-8');
  const createdEnv = writeIfMissing(envPath, envSeed);

  return {
    envPath,
    envExamplePath,
    createdEnv,
    createdEnvExample,
  };
}
