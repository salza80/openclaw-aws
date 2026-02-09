import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import initCommand from '../../src/cli/commands/init.js';
import { getConfigPathByName } from '../../src/cli/utils/config.js';
import { getCurrentName } from '../../src/cli/utils/config-store.js';

describe('init command', () => {
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

  it('defaults name in non-interactive mode and sets current', async () => {
    await initCommand.handler?.({
      yes: true,
      region: 'us-east-1',
      instanceType: 't3.micro'
    } as unknown as { yes: boolean; region: string; instanceType: string });

    const configPath = getConfigPathByName('my-openclaw-bot');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(getCurrentName()).toBe('my-openclaw-bot');
  });
});
