import { describe, expect, it } from 'vitest';
import { clonePolicyFromConfig } from '../../src/openclaw/clone-policy.js';

const members = ['main', 'researcher'].map((id) => ({
  id,
  workspace: `/home/ubuntu/${id}`,
  agentDir: `/home/ubuntu/.openclaw/agents/${id}/agent`,
}));
describe('clone source policy', () => {
  it('preserves explicit internal role and non-secret model/tool intent without source integration configuration', () => {
    const config = {
      agents: {
        defaults: {
          systemAgent: { agentId: 'researcher' },
          maxConcurrent: 3,
          model: { primary: 'openrouter/example', fallbacks: ['openrouter/backup'] },
          modelPolicy: { allow: ['openrouter/*'] },
          models: {
            'openrouter/example': { alias: 'work', params: { apiKey: 'private-model-key' } },
          },
        },
        entries: {
          main: {
            name: 'Coordinator',
            identity: { name: 'Lead', avatar: 'https://private.example/image' },
            tools: {
              profile: 'coding',
              deny: ['browser'],
              exec: { env: { TOKEN: 'private-tool-key' } },
            },
            subagents: { allowAgents: ['researcher'], delegationMode: 'prefer' },
          },
          researcher: {
            model: 'openrouter/research',
            modelPolicy: { allow: [] },
            skills: ['research'],
          },
        },
      },
      tools: {
        agentToAgent: { enabled: true, allow: ['main', 'researcher'] },
        sessions: { visibility: 'all' },
        web: { search: { apiKey: 'private-search-key' } },
      },
      secrets: {
        providers: {
          local: { source: 'file', path: '~/main/reference.json' },
          exec: { source: 'exec', command: 'private-command' },
        },
      },
      env: { KEY: 'private-env' },
      channels: { telegram: { botToken: 'private-channel' } },
      plugins: { entries: { unsafe: { config: { password: 'private-plugin' } } } },
    };
    const policy = clonePolicyFromConfig(config, members);
    expect(policy.systemAgent).toBe('researcher');
    expect(policy.maxConcurrent).toBe(3);
    expect(policy.models).toEqual({ 'openrouter/example': { alias: 'work' } });
    expect(policy.modelPolicy).toEqual({ allow: ['openrouter/*'] });
    expect(policy.agents.find((agent) => agent.id === 'researcher')?.modelPolicy).toEqual({
      allow: [],
    });
    expect(policy.agents[0].subagents).toEqual({
      allowAgents: ['researcher'],
      delegationMode: 'prefer',
    });
    expect(policy.agentToAgent).toEqual({ enabled: true, allow: ['main', 'researcher'] });
    expect(policy.agents[0].tools).toEqual({ profile: 'coding', deny: ['browser'] });
    expect(policy.credentialPaths).toEqual(['/home/ubuntu/main/reference.json']);
    expect(JSON.stringify(policy)).not.toContain('private-');
    expect(config.agents.entries.main.identity.avatar).toBe('https://private.example/image');
  });
  it('requires an exact complete roster while supporting the native implicit main agent', () => {
    expect(() => clonePolicyFromConfig({ agents: { entries: { main: {} } } }, members)).toThrow(
      'roster',
    );
    expect(() => clonePolicyFromConfig({}, members)).toThrow('roster');
    expect(() =>
      clonePolicyFromConfig({ agents: { entries: { main: {}, stranger: {} } } }, members),
    ).toThrow('roster');
    expect(clonePolicyFromConfig({}, [members[0]]).agents).toEqual([{ id: 'main' }]);
    expect(() => clonePolicyFromConfig({}, [members[1]])).toThrow('roster');
    expect(() => clonePolicyFromConfig({}, [])).toThrow('roster');
  });
  it('blocks unknown profiles, owners and unresolved model references rather than copying arbitrary configuration', () => {
    for (const config of [
      { agents: { defaults: { systemAgent: { agentId: 'other' } } } },
      { tools: { profile: 'custom-profile' } },
      { agents: { defaults: { model: '${SOURCE_MODEL}' } } },
    ])
      expect(() => clonePolicyFromConfig(config, [members[0]])).toThrow();
  });
});
