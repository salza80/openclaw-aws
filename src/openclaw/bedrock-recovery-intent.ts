import { isDeepStrictEqual } from 'node:util';
import { validAwsRegion } from '../aws/regions.js';
import { BEDROCK_PLUGIN } from './bedrock-configuration.js';
import { nativeBedrockConfigured } from './bedrock-native.js';
import { assertBedrockRoleInputs } from './bedrock-profile.js';
import { modelObject } from './model-contract.js';
import { nativeModelReference } from './model-control.js';

/** Nonsecret native connection intent. IAM policies, AWS profiles and temporary
 * credentials are host resources, not native archive data to adopt. */
export interface BedrockRecoveryIntent {
  authMode: 'instance-role';
  inferenceRegion: string;
  models: string[];
  plugin: typeof BEDROCK_PLUGIN;
}
export function parseBedrockRecoveryIntent(input: unknown): BedrockRecoveryIntent {
  const row = modelObject(input);
  if (
    Object.keys(row).some(
      (key) => !['authMode', 'inferenceRegion', 'models', 'plugin'].includes(key),
    ) ||
    row.authMode !== 'instance-role' ||
    typeof row.inferenceRegion !== 'string' ||
    !validAwsRegion(row.inferenceRegion) ||
    !Array.isArray(row.models) ||
    row.models.length > 256 ||
    !isDeepStrictEqual(row.plugin, BEDROCK_PLUGIN)
  )
    throw new Error('Unsupported Bedrock recovery connection intent');
  const models = row.models.map((value) => {
    const model = nativeModelReference(value);
    if (!model.startsWith('amazon-bedrock/'))
      throw new Error('Bedrock recovery intent contains another provider');
    return model;
  });
  if (new Set(models).size !== models.length)
    throw new Error('Repeated Bedrock recovery model reference');
  return {
    authMode: 'instance-role',
    inferenceRegion: row.inferenceRegion,
    models: models.sort(),
    plugin: { ...BEDROCK_PLUGIN },
  };
}
const record = (value: unknown) => (value === undefined ? {} : modelObject(value));
const modelReferences = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  const model = modelObject(value);
  if (model.primary !== undefined && typeof model.primary !== 'string')
    throw new Error('Invalid saved native primary model');
  if (
    model.fallbacks !== undefined &&
    (!Array.isArray(model.fallbacks) ||
      model.fallbacks.length > 256 ||
      model.fallbacks.some((reference) => typeof reference !== 'string'))
  )
    throw new Error('Invalid saved native fallback models');
  return [
    ...(model.primary ? [model.primary as string] : []),
    ...((model.fallbacks as string[] | undefined) ?? []),
  ];
};
/** Read only selected native references and the managed connection. Catalog
 * allowlists remain native policy; unused historical IAM grants are not cloned.
 * Alias lookup is configuration resolution, not an alternative model catalog. */
export function savedBedrockRecoveryIntent(options: {
  config: unknown;
  home: string;
  deploymentRegion: string;
  environment?: Record<string, string>;
  members?: { id: string; model?: string }[];
  sessionModels?: string[];
}): BedrockRecoveryIntent | undefined {
  const config = modelObject(options.config);
  const agents = record(config.agents),
    defaults = record(agents.defaults);
  const aliases = record(defaults.models);
  const models = new Set<string>();
  const add = (reference: string, overrides = aliases) => {
    const matches = Object.hasOwn(overrides, reference)
      ? [reference]
      : Object.entries(overrides)
          .filter(([, settings]) => record(settings).alias === reference)
          .map(([key]) => key);
    if (
      matches.some((match) => /^(?:amazon-bedrock|bedrock)\//.test(match)) &&
      matches.length !== 1
    )
      throw new Error('A Bedrock model alias is ambiguous; resolve it before recovery capture');
    const resolved = matches[0] ?? reference;
    if (/^(?:amazon-bedrock|bedrock)\//.test(resolved))
      models.add(
        nativeModelReference(`amazon-bedrock/${resolved.slice(resolved.indexOf('/') + 1)}`),
      );
  };
  for (const reference of modelReferences(defaults.model)) add(reference);
  const entries = record(agents.entries);
  const roster: Record<string, unknown>[] = Object.entries(entries).map(([id, value]) => ({
    ...modelObject(value),
    id,
  }));
  for (const agent of roster) {
    const scoped = { ...aliases, ...record(agent.models) };
    for (const reference of modelReferences(agent.model)) add(reference, scoped);
  }
  for (const member of options.members ?? [])
    if (member.model) {
      const configured = roster.find((agent) => agent.id === member.id);
      add(member.model, { ...aliases, ...record(configured?.models) });
    }
  for (const reference of options.sessionModels ?? []) add(reference);
  const entry = record(record(record(config.plugins).entries)[BEDROCK_PLUGIN.id]);
  const discovery = record(record(entry.config).discovery);
  const providers = record(record(config.models).providers);
  const profiles = record(record(config.auth).profiles);
  if (
    !models.size &&
    discovery.enabled !== true &&
    !Object.hasOwn(providers, BEDROCK_PLUGIN.id) &&
    !Object.hasOwn(profiles, 'amazon-bedrock:instance-role')
  )
    return undefined;
  if (typeof discovery.region !== 'string' || !validAwsRegion(discovery.region))
    throw new Error(
      'Saved Bedrock inference region is unavailable; review the managed connection before backup',
    );
  assertBedrockRoleInputs(options.home, options.deploymentRegion, options.environment ?? {});
  if (!nativeBedrockConfigured(config, { ...options, inferenceRegion: discovery.region }))
    throw new Error(
      'Saved Bedrock settings are not the supported instance-role connection; review them before recovery capture',
    );
  return parseBedrockRecoveryIntent({
    authMode: 'instance-role',
    inferenceRegion: discovery.region,
    models: [...models],
    plugin: BEDROCK_PLUGIN,
  });
}
