import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
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
  });
  it('saves required noninteractive Cloudflare Gateway metadata', async () => {
    await initCommand.handler?.({
      yes: true,
      name: 'cloudflare',
      apiProvider: 'cloudflare-ai-gateway-api-key',
      cloudflareAccountId: 'a'.repeat(32),
      cloudflareGatewayId: 'my-gateway',
      _: [],
      $0: 'openclaw-aws',
    });
    const config = JSON.parse(fs.readFileSync(getConfigPathByName('cloudflare'), 'utf8'));
    expect(config.openclaw.cloudflare).toEqual({
      accountId: 'a'.repeat(32),
      gatewayId: 'my-gateway',
    });
  });
});
