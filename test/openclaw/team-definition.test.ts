import { describe, expect, it } from 'vitest';
import {
  parseTeamDefinition,
  teamDefinitionDigest,
  teamMembers,
  teamNativeId,
} from '../../src/openclaw/team-definition.js';
import { teamConfigurationPatch, teamInstructions } from '../../src/openclaw/team-configuration.js';
import { clonePolicyFromConfig } from '../../src/openclaw/clone-policy.js';
const input = {
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Coordinator', instructions: 'Collect findings and review.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research the request.' },
    { id: 'reviewer', role: 'Reviewer', instructions: 'Review actual findings.' },
  ],
};
const home = '/home/ubuntu';
const main = {
  id: 'main',
  workspace: home + '/.openclaw/workspace',
  agentDir: home + '/.openclaw/agents/main/agent',
};
describe('native team definition and policy', () => {
  it('maps one coordinator to the existing main and keeps separate member roots', () => {
    const definition = parseTeamDefinition(input);
    expect(parseTeamDefinition(definition)).toEqual(definition);
    expect(teamDefinitionDigest(definition)).toMatch(/^[a-f0-9]{64}$/);
    expect(teamNativeId(definition, 'lead')).toBe('main');
    expect(definition.members[0].sendTo).toEqual(['researcher', 'reviewer']);
    expect(definition.members[1].sendTo).toEqual(['lead']);
    expect(definition.members[1].delegateTo).toEqual([]);
    const members = teamMembers(definition, home, main);
    expect(members.map((m) => m.id)).toEqual(['main', 'researcher', 'reviewer']);
    expect(new Set(members.map((m) => m.workspace)).size).toBe(3);
    expect(members[0]).toEqual(main);
  });
  it('refuses duplicate/reserved IDs, an absent coordinator and cross-team target grants', () => {
    for (const value of [
      { ...input, coordinator: 'missing' },
      { ...input, members: [input.members[0], input.members[0]] },
      { ...input, members: [...input.members, { ...input.members[1], id: 'main' }] },
      {
        ...input,
        members: [{ ...input.members[0], sendTo: ['unrelated'] }, ...input.members.slice(1)],
      },
      { ...input, members: [{ ...input.members[0], id: '__proto__' }, ...input.members.slice(1)] },
    ])
      expect(() => parseTeamDefinition(value)).toThrow();
  });
  it('accepts current model/tool policies and only explicit nonsecret credential references', () => {
    const definition = parseTeamDefinition({
      ...input,
      defaultModel: { primary: 'openrouter/test', fallbacks: ['amazon-bedrock/route'] },
      members: [
        { ...input.members[0], tools: { profile: 'coding', deny: ['browser'] } },
        ...input.members.slice(1),
      ],
      credentials: [
        { provider: 'openrouter-api-key', kind: 'env', reference: 'TEAM_OPENROUTER_KEY' },
      ],
      bindings: [
        { agentId: 'lead', match: { channel: 'telegram', peer: { kind: 'direct', id: '123' } } },
      ],
    });
    expect(definition.credentials[0].reference).toBe('TEAM_OPENROUTER_KEY');
    expect(definition.defaultModel).toEqual({
      primary: 'openrouter/test',
      fallbacks: ['amazon-bedrock/route'],
    });
    for (const credentials of [
      [{ provider: 'amazon-bedrock', kind: 'env', reference: 'KEY' }],
      [{ provider: 'openrouter-api-key', kind: 'value', reference: 'plaintext' }],
    ])
      expect(() => parseTeamDefinition({ ...input, credentials })).toThrow();
    expect(() => parseTeamDefinition({ ...input, apiKey: 'plaintext' })).toThrow();
    expect(() => parseTeamDefinition({ ...input, defaultModel: 'unqualified-model' })).toThrow();
  });
  it('bounds instructions, control requests and concurrency without silently truncating', () => {
    for (const value of [
      { ...input, maxConcurrent: 0 },
      { ...input, maxSpawnDepth: 6 },
      {
        ...input,
        members: [
          { ...input.members[0], instructions: 'x'.repeat(3001) },
          ...input.members.slice(1),
        ],
      },
      { ...input, members: input.members.map((m) => ({ ...m, instructions: 'x'.repeat(2800) })) },
    ])
      expect(() => parseTeamDefinition(value)).toThrow();
  });
  it('prepares native send-only/delegation policy without copying provider credentials or unrelated config', () => {
    const definition = parseTeamDefinition(input);
    const members = teamMembers(definition, home, main);
    const config = {
      agents: {
        entries: Object.fromEntries(
          members.map((m) => [m.id, { workspace: m.workspace, agentDir: m.agentDir }]),
        ),
      },
      models: { providers: { private: { apiKey: 'private-key' } } },
      channels: { private: { token: 'private-token' } },
    };
    const before = structuredClone(config);
    const patch = teamConfigurationPatch({ definition, home, members, config });
    expect(config).toEqual(before);
    expect(patch.agents?.defaults?.systemAgent).toEqual({ agentId: 'main' });
    expect(patch.agents?.defaults?.maxConcurrent).toBe(3);
    expect(patch.agents?.entries?.main.tools?.agentToAgent?.send).toEqual([
      'researcher',
      'reviewer',
    ]);
    expect(patch.agents?.entries?.reviewer.subagents?.allowAgents).toEqual([]);
    expect(patch.agents?.defaults?.subagents).toMatchObject({ maxConcurrent: 3, maxSpawnDepth: 2 });
    expect(patch.tools?.sessions?.visibility).toBe('self');
    expect(JSON.stringify(patch)).not.toContain('private-');
    expect(teamInstructions(definition, 'lead')).toContain('native agentId: researcher');
    expect(() =>
      teamConfigurationPatch({
        definition,
        home,
        members,
        config: { agents: { entries: { ...config.agents.entries, unrelated: {} } } },
      }),
    ).toThrow('unrelated');
    expect(() => teamMembers(definition, home, { ...main, workspace: '/unowned' })).toThrow(
      'owned default',
    );
  });
  it('keeps team sends and native concurrency when preparing an independent knowledge copy', () => {
    const definition = parseTeamDefinition(input);
    const members = teamMembers(definition, home, main);
    const config = { agents: { entries: Object.fromEntries(members.map((m) => [m.id, {}])) } };
    const patch = teamConfigurationPatch({ definition, home, members, config });
    const policy = clonePolicyFromConfig(patch, members);
    expect(policy.agents[0].tools?.agentToAgent?.send).toEqual(['researcher', 'reviewer']);
    expect(policy.agents[1].subagents?.allowAgents).toEqual([]);
    expect(policy.subagents).toMatchObject({
      maxConcurrent: 3,
      maxChildrenPerAgent: 3,
      maxSpawnDepth: 2,
      requireAgentId: true,
    });
  });
});
