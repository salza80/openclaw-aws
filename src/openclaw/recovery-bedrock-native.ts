import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inactiveBedrockConfiguration } from './bedrock-configuration.js';
import { nativeBedrockConfigured } from './bedrock-native.js';
import {
  assertBedrockRoleInputs,
  bedrockRoleProfile,
  prepareBedrockRoleProfile,
} from './bedrock-profile.js';
import {
  savedBedrockRecoveryIntent,
  parseBedrockRecoveryIntent,
  type BedrockRecoveryIntent,
} from './bedrock-recovery-intent.js';
import type { BedrockRecoveryPlan } from './bedrock-recovery-plan.js';
import { modelObject } from './model-contract.js';
import { privateModelText } from './model-journal.js';
import { assertDirectoryChain } from './restore-layout.js';
import { restoredPluginInstalls } from './restore-plugins.js';

export function assertRecoveryBedrockPlugin(registry: unknown, intent: BedrockRecoveryIntent) {
  const plugin = restoredPluginInstalls(registry).find((entry) => entry.id === intent.plugin.id);
  if (plugin?.spec !== intent.plugin.spec || plugin.integrity !== intent.plugin.integrity)
    throw new Error('Recovery Bedrock plugin provenance differs from the reviewed artifact');
}

/** The recovery worker owns maintenance and proves the Gateway inactive. Only
 * managed noncredential selectors are rebased; operator/static AWS identities
 * are never copied into the new connection. Other provider keys remain private. */
export async function prepareInactiveRecoveryBedrock(options: {
  config: unknown;
  environment: Record<string, string>;
  home: string;
  deploymentRegion: string;
  plan?: BedrockRecoveryPlan;
  source?: {
    home: string;
    deploymentRegion: string;
    members: { id: string; model?: string }[];
    sessionModels?: string[];
  };
}) {
  const config = structuredClone(modelObject(options.config));
  const environment = { ...options.environment };
  if (options.source) {
    const actual = savedBedrockRecoveryIntent({ ...options.source, config, environment });
    if (!isDeepStrictEqual(actual, options.plan?.intent))
      throw new Error(
        'Staged native Bedrock settings differ from the reviewed backup intent; target remains inactive',
      );
  }
  if (!options.plan) return { config, environment };
  const intent = parseBedrockRecoveryIntent(options.plan.intent);
  if (options.source) {
    const previous = bedrockRoleProfile(options.source.home, options.source.deploymentRegion);
    const env = config.env === undefined ? undefined : modelObject(config.env);
    for (const values of [
      environment,
      env,
      env?.vars === undefined ? undefined : modelObject(env.vars),
    ]) {
      if (!values) continue;
      for (const name of Object.keys(previous.environment)) delete values[name];
    }
  }
  assertBedrockRoleInputs(options.home, options.deploymentRegion, environment);
  const next = inactiveBedrockConfiguration({
    config,
    home: options.home,
    deploymentRegion: options.deploymentRegion,
    inferenceRegion: intent.inferenceRegion,
  });
  const managed = await prepareBedrockRoleProfile(options.home, options.deploymentRegion, {
    serviceEnvironment: true,
  });
  return { config: next, environment: { ...environment, ...managed.environment } };
}

/** Read-only activation validation; missing or changed role files are not
 * repaired over an active Gateway or silently adopted from a source host. */
export async function assertRecoveryBedrockNative(options: {
  config: unknown;
  environment: Record<string, string>;
  home: string;
  deploymentRegion: string;
  intent?: BedrockRecoveryIntent;
}) {
  if (!options.intent) return;
  const intent = parseBedrockRecoveryIntent(options.intent);
  assertBedrockRoleInputs(options.home, options.deploymentRegion, options.environment);
  if (
    !nativeBedrockConfigured(options.config, {
      ...options,
      inferenceRegion: intent.inferenceRegion,
    })
  )
    throw new Error('Recovery Bedrock native configuration changed before activation');
  const managed = bedrockRoleProfile(options.home, options.deploymentRegion);
  for (const [filename, expected] of [
    [managed.filename, managed.contents],
    [managed.serviceFilename, managed.serviceContents],
  ]) {
    await assertDirectoryChain(path.dirname(filename), options.home, false);
    if ((await privateModelText(filename)) !== expected)
      throw new Error(
        'Recovery managed role profile/service environment differs from the reviewed target',
      );
  }
}
