import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createWorkspace } from '../helpers/workspace.js';
import { runCli } from '../helpers/run-cli.js';

describe('cli config workflow', () => {
  let workspace: ReturnType<typeof createWorkspace>;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('creates config with init and lists it', async () => {
    await runCli(['init', '--name', 'alpha', '--yes'], workspace.cwd);

    const configPath = path.join(workspace.cwd, '.openclaw-aws', 'configs', 'alpha.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const list = await runCli(['config', 'list'], workspace.cwd);
    expect(list.stdout).toContain('alpha');
  });

  it('sets current config with config use', async () => {
    await runCli(['init', '--name', 'alpha', '--yes'], workspace.cwd);
    await runCli(['init', '--name', 'beta', '--yes'], workspace.cwd);

    await runCli(['config', 'use', 'beta'], workspace.cwd);

    const currentPath = path.join(workspace.cwd, '.openclaw-aws', 'current.json');
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
    expect(current.name).toBe('beta');
  });
});
