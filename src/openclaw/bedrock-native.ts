import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BEDROCK_PLUGIN, bedrockConfigurationPatch } from './bedrock-configuration.js';
import { modelObject, modelText } from './model-contract.js';
import { NativeCapabilityConsentRequired } from './model-client.js';
import type { NativeModelClient } from './model-control.js';

type Client = Pick<NativeModelClient, 'call' | 'health'>;
/** Keep config/auth entirely private. Only a digest of unrelated settings may
 * cross a plugin-lifecycle boundary; automatic native last-touch metadata is
 * not an operator setting. Entries/allowlist changes are limited to this plugin. */
export function bedrockUnrelatedConfigHash(input: unknown): string {
  const config = structuredClone(modelObject(input));
  const plugins = config.plugins as Record<string, unknown> | undefined;
  if (plugins) {
    if (Array.isArray(plugins.allow))
      plugins.allow = plugins.allow.filter((id) => id !== BEDROCK_PLUGIN.id);
    if (Array.isArray(plugins.allow) && !plugins.allow.length) delete plugins.allow;
    const entries = plugins.entries as Record<string, Record<string, unknown>> | undefined;
    if (entries?.[BEDROCK_PLUGIN.id]) {
      delete entries[BEDROCK_PLUGIN.id].enabled;
      const entry = entries[BEDROCK_PLUGIN.id];
      if (
        entry.config &&
        typeof entry.config === 'object' &&
        !Array.isArray(entry.config) &&
        !Object.keys(entry.config).length
      )
        delete entry.config;
      if (!Object.keys(entries[BEDROCK_PLUGIN.id]).length) delete entries[BEDROCK_PLUGIN.id];
    }
    if (entries && !Object.keys(entries).length) delete plugins.entries;
    if (!Object.keys(plugins).length) delete config.plugins;
  }
  const meta = config.meta as Record<string, unknown> | undefined;
  if (meta) {
    delete meta.lastTouchedAt;
    delete meta.lastTouchedVersion;
    if (!Object.keys(meta).length) delete config.meta;
  }
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(config)))
    .digest('hex');
}
export async function bedrockNativeSnapshot(client: Pick<NativeModelClient, 'call'>) {
  const value = modelObject(await client.call('config.get', {}));
  if (value.valid === false) throw new Error('Native configuration is invalid');
  return { hash: modelText(value.hash), config: modelObject(value.config) };
}
export function nativeBedrockConfigured(
  config: unknown,
  options: { home: string; deploymentRegion: string; inferenceRegion: string },
) {
  const patch = bedrockConfigurationPatch({ ...options, config });
  const matches = (row: unknown, desired: unknown): boolean => {
    if (desired && typeof desired === 'object' && !Array.isArray(desired)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
      return Object.entries(desired).every(([key, value]) =>
        matches((row as Record<string, unknown>)[key], value),
      );
    }
    return JSON.stringify(row) === JSON.stringify(desired);
  };
  return matches(config, patch);
}
/** Use the supported registry projection, not private install files. Refuse
 * replacing another installed version/source even when its display ID matches. */
export async function inspectNativeBedrockPlugin(client: Pick<NativeModelClient, 'call'>) {
  const catalog = modelObject(await client.call('plugins.list', {}));
  if (!Array.isArray(catalog.plugins)) throw new Error('Native plugin catalog is unavailable');
  const matches = catalog.plugins.map(modelObject).filter((row) => row.id === BEDROCK_PLUGIN.id);
  if (matches.length > 1) throw new Error('Native Bedrock plugin identity is ambiguous');
  const entry = matches[0];
  if (!entry || entry.installed === false) return { installed: false, enabled: false };
  if (entry.installed !== true || entry.version !== '2026.11.1')
    throw new Error(
      'A different Bedrock plugin version is installed; review it before changing the connection',
    );
  const inspected = modelObject(
    await client.call('plugins.inspect', { pluginId: BEDROCK_PLUGIN.id }),
  );
  const source = modelObject(inspected.source);
  const plugin = modelObject(inspected.plugin);
  if (
    inspected.ok !== true ||
    plugin.id !== BEDROCK_PLUGIN.id ||
    plugin.version !== '2026.11.1' ||
    source.kind !== 'npm' ||
    ![BEDROCK_PLUGIN.spec, BEDROCK_PLUGIN.spec.slice(4)].includes(
      source.spec as typeof BEDROCK_PLUGIN.spec,
    ) ||
    source.integrity !== BEDROCK_PLUGIN.integrity
  )
    throw new Error('Bedrock plugin provenance differs from the exact reviewed npm artifact');
  return { installed: true, enabled: entry.enabled === true && plugin.enabled === true };
}
async function lifecycle(
  client: Pick<NativeModelClient, 'call'>,
  method: 'plugins.install' | 'plugins.setEnabled',
  params: Record<string, unknown>,
  accept: boolean,
) {
  try {
    return await client.call(method, params);
  } catch (error) {
    if (
      !(error instanceof NativeCapabilityConsentRequired) ||
      error.pluginId !== BEDROCK_PLUGIN.id ||
      !accept
    )
      throw error;
    // This typed native gate precedes persistence. A lost/ordinary failure is
    // never retried. Consent is only for the exact integrity-bound plugin.
    return client.call(method, {
      ...params,
      acknowledgeCapabilities: { reviewToken: error.reviewToken },
    });
  }
}
export async function ensureNativeBedrockPlugin(
  client: Pick<NativeModelClient, 'call'>,
  acceptCapabilities: boolean,
) {
  if (!acceptCapabilities)
    throw new Error(
      'Approve the exact official Bedrock plugin capabilities before enabling this connection',
    );
  let plugin = await inspectNativeBedrockPlugin(client);
  if (!plugin.installed) {
    await lifecycle(
      client,
      'plugins.install',
      {
        source: 'npm',
        spec: BEDROCK_PLUGIN.spec.slice(4),
        pin: true,
        expectedPluginId: BEDROCK_PLUGIN.id,
        expectedIntegrity: BEDROCK_PLUGIN.integrity,
        enable: false,
        mode: 'install',
      },
      acceptCapabilities,
    );
    plugin = await inspectNativeBedrockPlugin(client);
    if (!plugin.installed)
      throw new Error('Native plugin install has no confirmed provenance receipt');
  }
  if (!plugin.enabled)
    await lifecycle(
      client,
      'plugins.setEnabled',
      { pluginId: BEDROCK_PLUGIN.id, enabled: true, allowlistPolicy: 'preserve' },
      acceptCapabilities,
    );
  plugin = await inspectNativeBedrockPlugin(client);
  if (!plugin.enabled) throw new Error('Native Bedrock plugin activation is not confirmed');
}

/** Native refresh publishes asynchronously. Await the provider-owned outcome;
 * an empty first page is neither readiness nor proof of denied access. Default
 * view retains native model policy; even a ready empty page grants no selection. */
export async function refreshNativeBedrockDiscovery(
  client: Client,
  options: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number } = {},
) {
  const roster = modelObject(await client.call('agents.list', {}));
  if (!Array.isArray(roster.agents) || !roster.agents.length)
    throw new Error('Native agent roster is unavailable');
  const ids = roster.agents.map((value) => modelText(modelObject(value).id, 64));
  const agentId =
    typeof roster.defaultId === 'string' && ids.includes(roster.defaultId)
      ? roster.defaultId
      : ids[0];
  const params = { agentId, provider: BEDROCK_PLUGIN.id, view: 'default', includeDetails: true };
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120000)])
    : AbortSignal.timeout(options.timeoutMs ?? 120000);
  let result = modelObject(await client.call('models.list', { ...params, refresh: true }));
  while (true) {
    signal.throwIfAborted();
    if (!Array.isArray(result.models)) throw new Error('Native Bedrock inventory is unavailable');
    const outcomes = Array.isArray(result.providerOutcomes)
      ? result.providerOutcomes.map(modelObject).filter((row) => row.provider === BEDROCK_PLUGIN.id)
      : [];
    if (outcomes.some((row) => row.status === 'auth-rejected'))
      throw new Error(
        'Native Bedrock metadata access was denied; inspect instance-role access, account restrictions and inference region. No inference was attempted',
      );
    if (outcomes.some((row) => row.status === 'unavailable'))
      throw new Error(
        'Native Bedrock discovery is unavailable; inspect regional service availability and connectivity. No inference was attempted',
      );
    if (
      outcomes.some((row) => row.status === 'ready') &&
      !(
        Array.isArray(result.pendingProviders) &&
        result.pendingProviders.includes(BEDROCK_PLUGIN.id)
      )
    )
      return {
        ready: true as const,
        visibleModels: result.models.length,
        checkedAt: new Date().toISOString(),
        inferenceVerified: false as const,
      };
    await delay(options.pollMs ?? 1000, undefined, { signal });
    await client.health();
    result = modelObject(await client.call('models.list', params));
  }
}
