import { mkdtemp, realpath, readFile, stat, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inactiveBedrockConfiguration } from '../../src/openclaw/bedrock-configuration.js';
import { savedBedrockRecoveryIntent } from '../../src/openclaw/bedrock-recovery-intent.js';
import { bedrockRoleProfile } from '../../src/openclaw/bedrock-profile.js';
import { nativeBedrockConfigured } from '../../src/openclaw/bedrock-native.js';
import {
  prepareInactiveRecoveryBedrock,
  assertRecoveryBedrockNative,
} from '../../src/openclaw/recovery-bedrock-native.js';
import type { BedrockRecoveryPlan } from '../../src/openclaw/bedrock-recovery-plan.js';
let home: string;
const sourceHome = '/home/ubuntu';
const sourceRegion = 'eu-central-1';
const deploymentRegion = 'ap-southeast-2';
const inferenceRegion = 'us-east-1';
function source() {
  return inactiveBedrockConfiguration({
    home: sourceHome,
    deploymentRegion: sourceRegion,
    inferenceRegion,
    config: {
      agents: {
        defaults: {
          model: { primary: 'openrouter/base', fallbacks: ['amazon-bedrock/provider.model'] },
        },
        ownership: 'explicit',
        entries: { reviewer: { model: 'openrouter/review' } },
      },
      auth: { profiles: { 'openrouter:target': { provider: 'openrouter', mode: 'api_key' } } },
      env: { vars: { OTHER_SETTING: 'retained' } },
    },
  });
}
function plan(): BedrockRecoveryPlan {
  const intent = savedBedrockRecoveryIntent({
    config: source(),
    home: sourceHome,
    deploymentRegion: sourceRegion,
  })!;
  const arn = `arn:aws:bedrock:${inferenceRegion}::foundation-model/provider.model`;
  return {
    intent,
    selection: {
      discoveryRegion: inferenceRegion,
      routes: [
        {
          model: intent.models[0],
          region: inferenceRegion,
          kind: 'foundation-model',
          invocationArn: arn,
          modelArns: [arn],
        },
      ],
    },
  };
}
const from = { home: sourceHome, deploymentRegion: sourceRegion, members: [] };
beforeEach(async () => {
  home = await realpath(await mkdtemp('/private/tmp/openclaw-recovery-role-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe('inactive recovery role environment', () => {
  it('recreates private target-region files and rebases only managed selectors, preserving mixed provider/agent settings', async () => {
    const config = source(),
      before = structuredClone(config);
    const environment = {
      ...bedrockRoleProfile(sourceHome, sourceRegion).environment,
      OPENROUTER_API_KEY: 'explicit-provider-key',
      OPENCLAW_GATEWAY_TOKEN: 'fresh-gateway-token',
    };
    const prepared = await prepareInactiveRecoveryBedrock({
      config,
      environment,
      home,
      deploymentRegion,
      plan: plan(),
      source: from,
    });
    const target = bedrockRoleProfile(home, deploymentRegion);
    expect(prepared.config.agents).toEqual(config.agents);
    expect(prepared.config.auth).toEqual(config.auth);
    expect(config).toEqual(before);
    expect(prepared.environment).toMatchObject({
      OPENROUTER_API_KEY: environment.OPENROUTER_API_KEY,
      OPENCLAW_GATEWAY_TOKEN: environment.OPENCLAW_GATEWAY_TOKEN,
      ...target.environment,
    });
    expect(
      nativeBedrockConfigured(prepared.config, { home, deploymentRegion, inferenceRegion }),
    ).toBe(true);
    expect(await readFile(target.filename, 'utf8')).toContain(deploymentRegion);
    expect(await readFile(target.filename, 'utf8')).not.toContain(sourceRegion);
    expect((await stat(target.filename)).mode & 0o777).toBe(0o600);
    expect(await readFile(target.serviceFilename, 'utf8')).toBe(target.serviceContents);
    await assertRecoveryBedrockNative({
      ...prepared,
      home,
      deploymentRegion,
      intent: plan().intent,
    });
  });
  it('refuses a stale saved model/region intent or foreign AWS identity before creating target role files', async () => {
    const changed = plan();
    changed.intent.models = [];
    await expect(
      prepareInactiveRecoveryBedrock({
        config: source(),
        environment: {},
        home,
        deploymentRegion,
        plan: changed,
        source: from,
      }),
    ).rejects.toThrow(/differ from the reviewed/);
    await expect(access(path.join(home, '.openclaw-aws/aws/config'))).rejects.toThrow();
    await expect(
      prepareInactiveRecoveryBedrock({
        config: source(),
        environment: { AWS_SESSION_TOKEN: 'private-old-token' },
        home,
        deploymentRegion,
        plan: plan(),
        source: from,
      }),
    ).rejects.toThrow(/AWS_SESSION_TOKEN/);
    await expect(access(path.join(home, '.openclaw-aws/aws/config'))).rejects.toThrow();
  });
  it('requires deliberate permission planning for archived Bedrock and leaves API-only recovery unchanged', async () => {
    await expect(
      prepareInactiveRecoveryBedrock({
        config: source(),
        environment: {},
        home,
        deploymentRegion,
        source: from,
      }),
    ).rejects.toThrow(/reviewed backup intent/);
    const config = { agents: { defaults: { model: 'openrouter/base' } } };
    const environment = { OPENROUTER_API_KEY: 'private-provider-key' };
    expect(
      await prepareInactiveRecoveryBedrock({
        config,
        environment,
        home,
        deploymentRegion,
        source: from,
      }),
    ).toEqual({ config, environment });
    await expect(access(path.join(home, '.openclaw-aws'))).rejects.toThrow();
  });
  it('does not repair or adopt changed role/service files during activation validation', async () => {
    const prepared = await prepareInactiveRecoveryBedrock({
      config: source(),
      environment: {},
      home,
      deploymentRegion,
      plan: plan(),
      source: from,
    });
    const target = bedrockRoleProfile(home, deploymentRegion);
    await writeFile(target.filename, '[profile operator]\ncredential_process=untrusted\n');
    await expect(
      assertRecoveryBedrockNative({ ...prepared, home, deploymentRegion, intent: plan().intent }),
    ).rejects.toThrow(/differs from the reviewed target/);
    expect(await readFile(target.filename, 'utf8')).toContain('credential_process');
  });
});
