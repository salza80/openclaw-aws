import type { CloneContentPlan } from './clone-content.js';
import type { CloneSourcePolicy } from './clone-policy.js';
import { restoredInactiveConfig } from './restore-reconciliation.js';

type ConfigSdk = typeof import('openclaw/plugin-sdk/config-mutation');
type NativeConfig = NonNullable<Parameters<ConfigSdk['replaceConfigFile']>[0]['sourceConfig']>;

/** Apply only reviewed knowledge-clone settings to a freshly onboarded native
 * configuration. No source installation config or identity is an input.
 */
export function inactiveCloneConfig(options: {
  fresh: NativeConfig;
  content: CloneContentPlan;
  policy: CloneSourcePolicy;
  gatewayToken: string;
}): NativeConfig {
  const { policy, content } = options;
  const config = restoredInactiveConfig(options.fresh, {
    gatewayToken: options.gatewayToken,
    oldPluginDirectory: '',
    pluginDirectory: '',
  });
  const entries = config.agents?.entries;
  if (
    !entries ||
    Object.keys(entries).length !== content.members.length ||
    content.members.length !== policy.agents.length ||
    content.members.some(
      (member) =>
        !Object.hasOwn(entries, member.id) ||
        !policy.agents.some((agent) => agent.id === member.id),
    )
  )
    throw new Error('Fresh native clone roster differs from the reviewed whole-team plan');
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.ownership = 'explicit';
  config.agents.defaults.skipBootstrap = true;
  config.agents.defaults.heartbeat = { every: '0m' };
  config.agents.defaults.systemAgent = policy.systemAgent ? { agentId: policy.systemAgent } : {};
  delete config.agents.defaults.authInheritance;
  delete config.agents.defaults.sessionStore;
  if (policy.subagents) config.agents.defaults.subagents = structuredClone(policy.subagents);
  if (policy.model) config.agents.defaults.model = structuredClone(policy.model);
  if (policy.models) config.agents.defaults.models = structuredClone(policy.models);
  else delete config.agents.defaults.models;
  config.tools = {
    ...(policy.tools ?? {}),
    ...(policy.agentToAgent ? { agentToAgent: structuredClone(policy.agentToAgent) } : {}),
    ...(policy.sessionVisibility ? { sessions: { visibility: policy.sessionVisibility } } : {}),
  };
  for (const member of content.members) {
    const settings = policy.agents.find((agent) => agent.id === member.id)!;
    const entry = entries[member.id];
    // Keep the native-created role's identity outside authored configuration.
    // Replace settings instead of inheriting implicit onboarding defaults.
    entries[member.id] = {
      ...entry,
      workspace: member.workspace,
      agentDir: member.agentDir,
      ...(settings.name !== undefined ? { name: settings.name } : {}),
      ...(settings.identity ? { identity: structuredClone(settings.identity) } : {}),
      ...(settings.model
        ? {
            model: {
              ...structuredClone(settings.model),
              ...(!settings.model.primary && member.model ? { primary: member.model } : {}),
            },
          }
        : member.model
          ? { model: member.model }
          : {}),
      ...(settings.skills ? { skills: [...settings.skills] } : {}),
      ...(settings.models ? { models: structuredClone(settings.models) } : {}),
      ...(settings.tools ? { tools: structuredClone(settings.tools) } : {}),
      ...(settings.subagents ? { subagents: structuredClone(settings.subagents) } : {}),
      heartbeat: { every: '0m' },
      memory: { search: { enabled: false } },
    };
  }
  config.channels = {};
  config.mcp = { servers: {} };
  config.memory = { search: { enabled: false } };
  return config;
}
