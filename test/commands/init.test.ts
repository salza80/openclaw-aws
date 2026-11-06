import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import initCommand, { configureDeployment } from '../../src/cli/commands/init.js';
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
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    workspace.cleanup();
  });
  it('saves explicit role auth and a separate inference region without displaying a model API-key requirement', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await configureDeployment({
      name: 'role',
      yes: true,
      apiProvider: 'amazon-bedrock',
      region: 'eu-central-1',
      bedrockRegion: 'us-east-1',
      model: 'amazon-bedrock/example-profile',
    });
    const config = JSON.parse(fs.readFileSync(getConfigPathByName('role'), 'utf8'));
    expect(config.openclaw).toEqual({
      apiProvider: 'amazon-bedrock',
      authMode: 'instance-role',
      bedrock: { region: 'us-east-1' },
      model: 'amazon-bedrock/example-profile',
    });
    expect(config.aws.region).toBe('eu-central-1');
    expect(JSON.stringify(output.mock.calls)).not.toContain('your-api-key');
    expect(JSON.stringify(output.mock.calls)).not.toContain('AMAZON_BEDROCK_API_KEY');
    await expect(
      configureDeployment({ name: 'missing-model', yes: true, apiProvider: 'amazon-bedrock' }),
    ).rejects.toThrow(/explicit amazon-bedrock/);
    expect(fs.existsSync(getConfigPathByName('missing-model'))).toBe(false);
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
