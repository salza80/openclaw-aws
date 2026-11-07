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

    const list = await runCli(['list'], workspace.cwd);
    expect(list.stdout).toContain('alpha');
  });

  it('sets current config with config use', async () => {
    await runCli(['init', '--name', 'alpha', '--yes'], workspace.cwd);
    await runCli(['init', '--name', 'beta', '--yes'], workspace.cwd);

    await runCli(['use', 'beta'], workspace.cwd);

    const currentPath = path.join(workspace.cwd, '.openclaw-aws', 'current.json');
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
    expect(current.name).toBe('beta');
  });
  it('keeps machine-readable output free of dotenv startup notices', async () => {
    fs.writeFileSync(path.join(workspace.cwd, '.env'), 'CLI_STDOUT_FIXTURE=nonsecret\n');
    const result = await runCli(['--version'], workspace.cwd);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+(?:[-+]\S+)?$/);
  });
  it('reports the CLI package version rather than the surrounding project version', async () => {
    fs.writeFileSync(
      path.join(workspace.cwd, 'package.json'),
      JSON.stringify({ name: 'consumer-project', version: '99.0.0', private: true }),
    );
    const expected = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ).version;
    const result = await runCli(['--version'], workspace.cwd);
    expect(result.stdout).toBe(expected);
    expect(result.stdout).not.toBe('99.0.0');
  });
});
