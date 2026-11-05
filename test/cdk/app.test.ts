import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWorkspace } from '../helpers/workspace.js';

describe('CDK app provisioning validation', () => {
  let workspace: ReturnType<typeof createWorkspace>;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(() => workspace.cleanup());

  function runApp(operation: 'deploy' | 'destroy', snapshot?: object, region?: string) {
    const configDirectory = join(workspace.cwd, '.openclaw-aws', 'configs');
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, 'legacy.json'),
      JSON.stringify({
        version: '1.0',
        aws: { region: 'us-east-1' },
        instance: { type: 't3.small', name: 'openclaw-legacy' },
        network: { useDefaultVpc: true },
        features: { cloudWatchLogs: true },
        stack: { name: 'OpenclawStack-legacy' },
        openclaw: { apiProvider: 'cloudflare-ai-gateway-api-key' },
      }),
    );

    const appPath = fileURLToPath(new URL('../../dist/cdk/app.js', import.meta.url));
    return spawnSync(process.execPath, [appPath], {
      cwd: workspace.cwd,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_NAME: 'legacy',
        OPENCLAW_CDK_OPERATION: operation,
        OPENCLAW_CONFIG_SNAPSHOT: snapshot ? JSON.stringify(snapshot) : undefined,
        AWS_REGION: region,
        CDK_DEFAULT_ACCOUNT: '123456789012',
        CDK_OUTDIR: join(workspace.cwd, 'assembly'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  it('rejects legacy Cloudflare routing metadata before synthesizing new infrastructure', () => {
    const result = runApp('deploy');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Provisioning configuration validation failed');
    expect(result.stderr).toContain('openclaw.cloudflare.accountId');
    expect(result.stderr).toContain('openclaw.cloudflare.gatewayId');
    expect(result.stdout).toBe('');
  });

  it('synthesizes only the existing stack identity for destruction without provisioning metadata', () => {
    const result = runApp('destroy');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const assemblyDirectory = join(workspace.cwd, 'assembly');
    const manifest = JSON.parse(readFileSync(join(assemblyDirectory, 'manifest.json'), 'utf8'));
    const artifact = manifest.artifacts['OpenclawStack-legacy'];
    expect(artifact.type).toBe('aws:cloudformation:stack');
    expect(artifact.environment).toBe('aws://123456789012/us-east-1');
    // CDK omits stackName when it is identical to the artifact ID.
    expect(artifact.properties.stackName ?? 'OpenclawStack-legacy').toBe('OpenclawStack-legacy');
    expect(artifact.properties.assumeRoleArn).toContain(':role/');
    expect(manifest.missing ?? []).toEqual([]);
    const template = JSON.parse(
      readFileSync(join(assemblyDirectory, artifact.properties.templateFile), 'utf8'),
    );
    expect(template.Resources ?? {}).toEqual({});
    expect(template.Parameters ?? {}).toEqual({});
    expect(JSON.stringify(template)).not.toMatch(
      /cloudflare|ssm:|SignalResource|UserData|openclaw/i,
    );
  });
  it('uses the pinned parent snapshot even if the named configuration file differs', () => {
    const snapshot = {
      version: '1.0',
      aws: { region: 'eu-central-1' },
      instance: { type: 't3.small', name: 'openclaw-pinned' },
      network: { useDefaultVpc: true },
      features: { cloudWatchLogs: false },
      stack: { name: 'OpenclawStack-pinned' },
      openclaw: { apiProvider: 'openrouter-api-key' },
    };
    const result = runApp('destroy', snapshot, 'eu-central-1');
    expect(result.status).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(workspace.cwd, 'assembly/manifest.json'), 'utf8'),
    );
    expect(manifest.artifacts['OpenclawStack-pinned'].environment).toBe(
      'aws://123456789012/eu-central-1',
    );
    expect(manifest.artifacts['OpenclawStack-legacy']).toBeUndefined();
    const mismatch = runApp('destroy', snapshot, 'us-east-1');
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('does not match the selected AWS region');
  });

  it('rejects malformed parent snapshots before synthesis', () => {
    const result = runApp(
      'destroy',
      { version: '1.0', aws: { region: 'eu-central-1' } },
      'eu-central-1',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid deployment configuration snapshot');
  });
});
