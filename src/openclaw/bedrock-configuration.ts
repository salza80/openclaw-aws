import { isDeepStrictEqual } from 'node:util';
import { validAwsRegion } from '../aws/regions.js';
import { assertBedrockRoleInputs, bedrockRoleProfile } from './bedrock-profile.js';
import { modelObject, modelText } from './model-contract.js';
import { ModelControlError, type NativeModelClient } from './model-control.js';

export const BEDROCK_PLUGIN = {
  id: 'amazon-bedrock',
  spec: 'npm:@openclaw/amazon-bedrock-provider@2026.11.1',
  integrity:
    'sha512-uDt7jSEhyDjuwcKvTGeYdD/idkDVL9uHaKJyS+VGc+xZgmalkkJ0sAnsXLL2Kstp2dqeygC2UkYmAxWQKISHfg==',
} as const;
const optionalObject = (value: unknown) => (value === undefined ? {} : modelObject(value));
const child = (value: Record<string, unknown>, key: string) => optionalObject(value[key]);

/** The same provider settings are used for fresh, restored, cloned and existing
 * installations. Native OpenClaw owns discovery/catalogs and inference. This
 * patch never chooses a model or edits another connection's credentials. */
export function bedrockConfigurationPatch(options: {
  config: unknown;
  home: string;
  deploymentRegion: string;
  inferenceRegion: string;
}): Record<string, unknown> {
  if (!validAwsRegion(options.inferenceRegion)) throw new Error('Invalid Bedrock inference region');
  const config = modelObject(options.config);
  const env = child(config, 'env');
  assertBedrockRoleInputs(options.home, options.deploymentRegion, env);
  assertBedrockRoleInputs(options.home, options.deploymentRegion, child(env, 'vars'));
  const plugins = child(config, 'plugins');
  if (
    plugins.enabled === false ||
    (Array.isArray(plugins.deny) && plugins.deny.includes(BEDROCK_PLUGIN.id))
  )
    throw new Error(
      'Native plugin policy blocks Bedrock; review plugin loading/deny settings before enabling this connection',
    );
  const entry = child(child(plugins, 'entries'), BEDROCK_PLUGIN.id);
  const discovery = child(child(entry, 'config'), 'discovery');
  if (discovery.region !== undefined && discovery.region !== options.inferenceRegion)
    throw new Error(
      'Existing Bedrock discovery uses another inference region; review a whole-host region change',
    );
  const provider = child(child(config, 'models'), 'providers');
  const bedrock = child(provider, BEDROCK_PLUGIN.id);
  // Regional AWS runtime endpoints are supplied by AWS configuration, never a
  // custom model proxy or a saved endpoint from the source machine.
  const suffix = options.inferenceRegion.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const endpoint = `https://bedrock-runtime.${options.inferenceRegion}.${suffix}`;
  if (
    (bedrock.api !== undefined && bedrock.api !== 'bedrock-converse-stream') ||
    (bedrock.auth !== undefined && bedrock.auth !== 'aws-sdk') ||
    (bedrock.baseUrl !== undefined && bedrock.baseUrl !== endpoint) ||
    (bedrock.apiKey !== undefined && bedrock.apiKey !== '') ||
    (bedrock.headers !== undefined && Object.keys(modelObject(bedrock.headers)).length)
  )
    throw new Error(
      'Existing Bedrock provider has conflicting authentication or endpoint settings; review privately before enabling instance-role access',
    );
  const profiles = child(child(config, 'auth'), 'profiles');
  const profile = profiles['amazon-bedrock:instance-role'];
  if (
    profile !== undefined &&
    !isDeepStrictEqual(profile, { provider: BEDROCK_PLUGIN.id, mode: 'aws-sdk' })
  )
    throw new Error('The managed Bedrock native auth profile already has different settings');
  if (
    plugins.allow !== undefined &&
    (!Array.isArray(plugins.allow) || plugins.allow.some((id) => typeof id !== 'string'))
  )
    throw new Error('Native plugin allowlist is invalid');
  if (bedrock.models !== undefined && !Array.isArray(bedrock.models))
    throw new Error('Native Bedrock model definitions are invalid');
  return {
    // Native catalog owners run with prepared environments rather than the
    // service's complete inherited env. Persist only these credential-free
    // selectors as well as installing the identical service environment.
    env: { vars: bedrockRoleProfile(options.home, options.deploymentRegion).environment },
    plugins: {
      ...(Array.isArray(plugins.allow)
        ? { allow: [...new Set([...plugins.allow, BEDROCK_PLUGIN.id])] }
        : {}),
      entries: {
        [BEDROCK_PLUGIN.id]: {
          enabled: true,
          config: { discovery: { enabled: true, region: options.inferenceRegion } },
        },
      },
    },
    models: {
      providers: {
        [BEDROCK_PLUGIN.id]: {
          baseUrl: endpoint,
          api: 'bedrock-converse-stream',
          auth: 'aws-sdk',
          ...(bedrock.models === undefined ? { models: [] } : {}),
        },
      },
    },
    auth: {
      profiles: {
        'amazon-bedrock:instance-role': { provider: BEDROCK_PLUGIN.id, mode: 'aws-sdk' },
      },
    },
  };
}

/** Inactive recovery uses the same owned patch through the public native file
 * SDK. This returns a private full config, never an operation result/journal. */
export function inactiveBedrockConfiguration(
  options: Parameters<typeof bedrockConfigurationPatch>[0],
) {
  const merge = (
    source: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result = structuredClone(source);
    for (const [key, value] of Object.entries(patch))
      result[key] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? merge(optionalObject(result[key]), value as Record<string, unknown>)
          : structuredClone(value);
    return result;
  };
  return merge(modelObject(options.config), bedrockConfigurationPatch(options));
}

/** Check only fields owned by this patch. Concurrent unrelated native settings
 * remain untouched, while another writer changing our fields blocks rollback. */
function matches(config: unknown, patch: Record<string, unknown>): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const row = config as Record<string, unknown>;
  return Object.entries(patch).every(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? matches(row[key], value as Record<string, unknown>)
      : value === null
        ? row[key] === undefined
        : isDeepStrictEqual(row[key], value),
  );
}
function inverse(
  config: Record<string, unknown>,
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => {
      const previous = config[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // A formerly absent parent may now also contain another writer's
        // settings. Delete it only if its entire current value is ours.
        if (previous === undefined && isDeepStrictEqual(current[key], value)) return [key, null];
        return [
          key,
          inverse(
            optionalObject(previous),
            value as Record<string, unknown>,
            optionalObject(current[key]),
          ),
        ];
      }
      if (previous === undefined) return [key, null];
      return [key, structuredClone(previous)];
    }),
  );
}
async function snapshot(client: Pick<NativeModelClient, 'call'>) {
  const result = modelObject(await client.call('config.get', {}));
  if (result.valid === false) throw new Error('Native configuration is invalid');
  return { hash: modelText(result.hash), config: modelObject(result.config) };
}
export interface BedrockConfigurationEvent {
  phase: 'intent' | 'acknowledged' | 'complete' | 'rolled-back' | 'uncertain';
  beforeHash: string;
  inferenceRegion: string;
}

/** The host owns flock/durable maintenance, verified plugin installation, exact
 * IAM readback and managed role/service environment before calling this. A real
 * restart is explicit: the service must acquire its new region-only profile.
 * Journals contain no full native config/auth output. Lost acknowledgements are
 * never replayed. Reconciliation belongs to the durable host controller. */
export async function configureNativeBedrock(
  client: Pick<NativeModelClient, 'call' | 'health' | 'restart'>,
  options: {
    home: string;
    deploymentRegion: string;
    inferenceRegion: string;
    expectedHash: string;
    allowRestart: boolean;
    record(event: BedrockConfigurationEvent): Promise<void>;
    verify?: () => Promise<void>;
  },
) {
  if (!options.allowRestart)
    throw new ModelControlError(
      'unchanged',
      'Bedrock enablement needs explicit approval for a controlled Gateway restart',
    );
  const before = await snapshot(client);
  if (before.hash !== options.expectedHash)
    throw new ModelControlError(
      'conflict',
      'Native configuration changed after Bedrock preview; prepare a fresh preview',
    );
  const patch = bedrockConfigurationPatch({ ...options, config: before.config });
  const identity = { beforeHash: before.hash, inferenceRegion: options.inferenceRegion };
  await options.record({ ...identity, phase: 'intent' });
  let acknowledged = false;
  try {
    const result = modelObject(
      await client.call('config.patch', {
        baseHash: before.hash,
        raw: JSON.stringify(patch),
        response: 'summary',
      }),
    );
    if (result.ok !== true) throw new Error('Native Bedrock configuration was not acknowledged');
    acknowledged = true;
    await options.record({ ...identity, phase: 'acknowledged' });
    await client.restart();
    await client.health();
    const after = await snapshot(client);
    if (!matches(after.config, patch))
      throw new Error('Native Bedrock configuration changed during activation');
    await options.verify?.();
    await options.record({ ...identity, phase: 'complete' });
    return {
      phase: 'complete' as const,
      inferenceRegion: options.inferenceRegion,
      checkedAt: new Date().toISOString(),
      restarted: true as const,
      inferenceVerified: false as const,
    };
  } catch {
    if (!acknowledged) {
      await options.record({ ...identity, phase: 'uncertain' }).catch(() => {});
      throw new ModelControlError(
        'uncertain',
        'Bedrock configuration was not acknowledged; inspect the recorded operation without replaying it',
      );
    }
    try {
      const current = await snapshot(client);
      if (!matches(current.config, patch))
        throw new Error('Another native writer changed Bedrock configuration');
      const rollback = inverse(before.config, patch, current.config);
      const result = modelObject(
        await client.call('config.patch', {
          baseHash: current.hash,
          raw: JSON.stringify(rollback),
          response: 'summary',
        }),
      );
      if (result.ok !== true) throw new Error('Bedrock rollback was not acknowledged');
      await client.restart();
      await client.health();
      if (!matches((await snapshot(client)).config, rollback))
        throw new Error('Bedrock rollback is unconfirmed');
      await options.record({ ...identity, phase: 'rolled-back' });
    } catch {
      await options.record({ ...identity, phase: 'uncertain' }).catch(() => {});
      throw new ModelControlError(
        'uncertain',
        'Bedrock activation or rollback could not be confirmed; retain maintenance and inspect before another mutation',
      );
    }
    throw new ModelControlError(
      'rolled-back',
      'Bedrock activation failed; previous native settings were restored. The installed plugin, role profile and additive IAM permissions remain for inspection',
    );
  }
}
