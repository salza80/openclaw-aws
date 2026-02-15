import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveConfigByName } from '../../src/cli/utils/config.js';
import {
  listConfigNames,
  resolveConfig,
  getCurrentName,
  setCurrentName,
} from '../../src/cli/utils/config-store.js';

const validConfig = {
  version: '1.0',
  aws: {
    region: 'us-east-1',
  },
  network: {
    useDefaultVpc: true,
  },
  instance: {
    type: 't3.micro',
    name: 'openclaw-my-openclaw-bot',
  },
  features: {
    cloudWatchLogs: true,
  },
  stack: {
    name: 'OpenclawStack-my-openclaw-bot',
  },
  openclaw: {
    apiProvider: 'anthropic-api-key',
  },
};

describe('config-store', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-aws-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists no configs when empty', () => {
    expect(listConfigNames()).toEqual([]);
  });

  it('saves and lists configs by name', () => {
    saveConfigByName(validConfig, 'alpha');
    saveConfigByName(validConfig, 'beta');
    expect(listConfigNames()).toEqual(['alpha', 'beta']);
  });

  it('sets and gets current name', () => {
    setCurrentName('alpha');
    expect(getCurrentName()).toBe('alpha');
  });

  it('resolves single config and sets it current', () => {
    saveConfigByName(validConfig, 'solo');
    const resolved = resolveConfig();
    expect(resolved.name).toBe('solo');
    expect(getCurrentName()).toBe('solo');
  });

  it('throws when multiple configs exist and no current is set', () => {
    saveConfigByName(validConfig, 'alpha');
    saveConfigByName(validConfig, 'beta');
    expect(() => resolveConfig()).toThrow('No config selected');
  });

  it('throws when current points to missing config', () => {
    setCurrentName('ghost');
    expect(() => resolveConfig()).toThrow('Config not found');
  });

  it('throws for missing config name', () => {
    expect(() => resolveConfig({ name: 'missing' })).toThrow('Config not found');
  });
});
