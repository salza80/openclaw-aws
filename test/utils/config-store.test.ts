import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getConfigPathByName,
  getOutputsPathByName,
  loadConfigByName,
  loadOutputsByName,
  saveConfigByName,
} from '../../src/cli/utils/config.js';
import {
  listConfigNames,
  resolveConfig,
  getCurrentName,
  setCurrentName,
} from '../../src/cli/utils/config-store.js';
import { createWorkspace } from '../helpers/workspace.js';

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
  let workspace: ReturnType<typeof createWorkspace>;

  beforeEach(() => {
    workspace = createWorkspace();
    process.chdir(workspace.cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    workspace.cleanup();
  });

  it('lists no configs when empty', () => {
    expect(listConfigNames()).toEqual([]);
  });

  it.each(['../escape', '../../escape', '/tmp/escape', '..\\escape', '.', '', 'a'.repeat(51)])(
    'rejects the invalid local deployment name %j at every config/output path boundary',
    (name) => {
      for (const operation of [
        getConfigPathByName,
        getOutputsPathByName,
        loadConfigByName,
        loadOutputsByName,
      ])
        expect(() => operation(name)).toThrow('Invalid deployment name');
      expect(() => saveConfigByName(validConfig, name)).toThrow('Invalid deployment name');
    },
  );

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

  it('loads legacy Cloudflare configs without requiring new provisioning metadata', () => {
    const legacy = {
      ...validConfig,
      openclaw: { apiProvider: 'cloudflare-ai-gateway-api-key' as const },
    };
    saveConfigByName(legacy, 'cloudflare');
    expect(resolveConfig({ name: 'cloudflare' }).config).toEqual(legacy);
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
