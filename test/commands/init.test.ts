import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import initCommand from '../../src/cli/commands/init.js';
import { getConfigPathByName } from '../../src/cli/utils/config.js';
import { getCurrentName } from '../../src/cli/utils/config-store.js';
import { createWorkspace } from '../helpers/workspace.js';

describe('init command', () => {
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

  it('defaults name in non-interactive mode and sets current', async () => {
    await initCommand.handler?.({
      yes: true,
      region: 'us-east-1',
      instanceType: 't3.micro',
    } as unknown as { yes: boolean; region: string; instanceType: string });

    const configPath = getConfigPathByName('my-openclaw-bot');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(getCurrentName()).toBe('my-openclaw-bot');

    const envPath = path.join(workspace.cwd, '.env');
    const envExamplePath = path.join(workspace.cwd, '.env.example');
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(envExamplePath)).toBe(true);

    const envTemplate = fs.readFileSync(envPath, 'utf-8');
    expect(envTemplate).toContain('ANTHROPIC_API_KEY=---yourkey---');
    expect(envTemplate).toContain('OPENAI_API_KEY=---yourkey---');
  });

  it('creates and initializes a target folder when passed as positional arg', async () => {
    await initCommand.handler?.({
      yes: true,
      folder: 'new-bot',
      name: 'alpha',
    } as unknown as { yes: boolean; folder: string; name: string });

    const projectDir = path.join(workspace.cwd, 'new-bot');
    const configPath = path.join(projectDir, '.openclaw-aws', 'configs', 'alpha.json');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.env.example'))).toBe(true);
  });
});
