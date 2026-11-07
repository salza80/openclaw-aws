import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTeamDefinition, teamMembers } from '../../src/openclaw/team-definition.js';
import { teamConfigurationPatch } from '../../src/openclaw/team-configuration.js';
import {
  teamIdentity,
  publishTeamMembership,
  captureTeamRecovery,
  parseTeamRecovery,
  teamPolicyDigest,
} from '../../src/openclaw/team-recovery.js';
import { restoredInactiveConfig } from '../../src/openclaw/restore-reconciliation.js';
import { modelJob } from '../helpers/model-operation.js';
let home: string;
const definition = parseTeamDefinition({
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Coordinator', instructions: 'Coordinate.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research.' },
  ],
});
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'team-recovery-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe('team identity and native recovery policy', () => {
  it('binds the role mapping to its host and captures current native policy rather than initial model intent', async () => {
    const identity = teamIdentity(modelJob.operationId, definition);
    const members = teamMembers(definition, home, {
      id: 'main',
      workspace: path.join(home, '.openclaw/workspace'),
      agentDir: path.join(home, '.openclaw/agents/main/agent'),
    });
    await publishTeamMembership(home, modelJob.target, identity);
    const policy = teamConfigurationPatch({
      definition,
      home,
      members,
      config: {
        agents: { entries: Object.fromEntries(members.map((member) => [member.id, member])) },
      },
    });
    const current = {
      ...policy,
      agents: {
        ...policy.agents,
        defaults: { ...policy.agents?.defaults, model: 'openrouter/current-confirmed-model' },
      },
      models: { privateKey: 'must-not-enter-metadata' },
    };
    const capture = await captureTeamRecovery(home, modelJob.target, members, current);
    expect(capture).toMatchObject({ id: identity.id, policyDigest: teamPolicyDigest(current) });
    expect(JSON.stringify(capture)).not.toContain('must-not-enter-metadata');
    expect(parseTeamRecovery(capture, members)).toEqual(capture);
    await expect(
      captureTeamRecovery(
        home,
        { ...modelJob.target, instanceId: 'i-1234567890abcdef0' },
        members,
        current,
      ),
    ).rejects.toThrow('ownership');
    await expect(
      captureTeamRecovery(home, modelJob.target, members.slice(0, 1), current),
    ).rejects.toThrow('complete native roster');
    expect(
      await readFile(path.join(home, '.openclaw-aws/team-members.json'), 'utf8'),
    ).not.toContain('privateKey');
  });
  it('preserves coordination/model policy while deliberately pausing integrations and rotating the token', () => {
    const current = {
      agents: {
        defaults: {
          model: { primary: 'openrouter/current', fallbacks: ['anthropic/fallback'] },
          subagents: { maxConcurrent: 3 },
        },
        entries: {
          main: { tools: { agentToAgent: { send: ['researcher'] } } },
          researcher: { model: 'anthropic/research', subagents: { allowAgents: [] } },
        },
      },
      tools: { agentToAgent: { enabled: true, allow: ['main', 'researcher'] } },
      bindings: [{ agentId: 'main', match: { channel: 'telegram' } }],
      channels: { telegram: { enabled: true } },
    };
    const recovered = restoredInactiveConfig(current, {
      gatewayToken: 'a'.repeat(48),
      oldPluginDirectory: '/old',
      pluginDirectory: '/new',
    });
    expect(teamPolicyDigest(recovered)).toBe(teamPolicyDigest(current));
    recovered.agents!.entries!.researcher!.model = 'anthropic/changed';
    expect(teamPolicyDigest(recovered)).not.toBe(teamPolicyDigest(current));
  });
  it('does not attach team ownership to an ordinary installation', async () => {
    await expect(captureTeamRecovery(home, modelJob.target, [], {})).resolves.toBeUndefined();
  });
  it('refuses a team whose role mapping was lost instead of completing an ordinary backup', async () => {
    await publishTeamMembership(
      home,
      modelJob.target,
      teamIdentity(modelJob.operationId, definition),
    );
    await rm(path.join(home, '.openclaw-aws/team-members.json'));
    await expect(captureTeamRecovery(home, modelJob.target, [], {})).rejects.toThrow(
      'role mapping is missing',
    );
  });
});
