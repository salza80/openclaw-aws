import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({
  root: '',
  create: vi.fn(),
  context: vi.fn(),
  source: vi.fn(),
  credentials: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  inspect: vi.fn(),
  describe: vi.fn(),
  provider: vi.fn(),
  providerApply: vi.fn(),
  providerCancel: vi.fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({
  getConfigRoot: () => mocks.root,
  loadConfigByName: vi.fn(),
}));
vi.mock('../../src/cli/utils/config-store.js', () => ({ getCurrentName: () => undefined }));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/cli/utils/create-flow.js', () => ({ createFreshDeployment: mocks.create }));
vi.mock('../../src/cli/utils/team-file.js', () => ({ teamCredentials: mocks.credentials }));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createCloudFormationClient: () => ({ send: mocks.describe, destroy() {} }),
}));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/operations/teams.js', () => ({
  prepareTeam: mocks.prepare,
  applyTeam: mocks.apply,
  inspectTeamOperation: mocks.inspect,
}));
vi.mock('../../src/operations/state.js', () => ({ loadDeploymentState: () => undefined }));
vi.mock('../../src/operations/bedrock.js', () => ({
  prepareBedrockConnection: mocks.provider,
  applyBedrockConnection: mocks.providerApply,
  cancelBedrockConnection: mocks.providerCancel,
}));
import {
  createFreshTeam,
  resumeFreshTeam,
  enableTeamBedrock,
} from '../../src/cli/utils/team-create-flow.js';
import { parseTeamDefinition } from '../../src/openclaw/team-definition.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const ctx = makeCommandContext();
const definition = parseTeamDefinition({
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Coordinator', instructions: 'Coordinate.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research.' },
  ],
  credentials: [
    { provider: 'openrouter-api-key', kind: 'env', reference: 'TEAM_ROUTER_KEY' },
    { provider: 'openai-api-key', kind: 'env', reference: 'TEAM_OPENAI_KEY' },
  ],
});
const source = {
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/OpenclawStack-alpha/original',
  instanceId: 'i-1234567890abcdef0',
  role: { id: 'AROATESTROLE00000001' },
};
let directory: string;
let bootstrap: { operationId: string; teamId: string; providers: string[] };
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), 'team-create-'));
  mocks.root = path.join(directory, '.openclaw-aws');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.context.mockResolvedValue(ctx);
  mocks.source.mockResolvedValue(source);
  mocks.credentials.mockResolvedValue({
    'openrouter-api-key': 'private-router-key',
    'openai-api-key': 'private-openai-key',
  });
  mocks.create.mockImplementation(async (_argv, options) => {
    const extra = await options.prepare(ctx);
    bootstrap = extra.team;
    // This hook runs before the shared workflow starts provisioning.
    const request = await readFile(
      path.join(mocks.root, 'team-create', bootstrap.operationId, 'request.json'),
      'utf8',
    );
    expect(request).not.toContain('private-router-key');
    expect(request).not.toContain('private-openai-key');
    expect(extra.additionalCredentials).toEqual({ 'openai-api-key': 'private-openai-key' });
    expect(options.apiKey).toBe('private-router-key');
    return ctx;
  });
  mocks.prepare.mockImplementation(async (_ctx, options) => ({
    job: { ...options, target: { instanceId: source.instanceId } },
  }));
  mocks.apply.mockResolvedValue({ recordedPhase: 'complete' });
  mocks.describe.mockImplementation(async () => ({
    Stacks: [
      {
        StackId: source.stackId,
        StackStatus: 'CREATE_COMPLETE',
        Tags: [
          { Key: 'openclaw-aws:team-id', Value: bootstrap.teamId },
          { Key: 'openclaw-aws:team-create-id', Value: bootstrap.operationId },
        ],
      },
    ],
  }));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const options = { approve: async () => true };
describe('one-host fresh team workflow', () => {
  it('persists nonsecret ownership before one shared provisioning call, then configures native roles', async () => {
    await createFreshTeam({ name: ctx.name, yes: true }, definition, options);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(bootstrap.providers).toEqual(['openai-api-key']);
    expect(mocks.prepare).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        teamId: bootstrap.teamId,
        operationId: bootstrap.operationId,
        definition,
      }),
    );
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('private-router-key'));
  });
  it('resumes only the tagged original ready host without invoking provisioning again', async () => {
    await createFreshTeam({ name: ctx.name, yes: true }, definition, options);
    await resumeFreshTeam(bootstrap.operationId, options);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.describe).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.calls.at(-1)![1].operationId).toBe(bootstrap.operationId);
    mocks.describe.mockResolvedValueOnce({
      Stacks: [{ StackId: source.stackId, StackStatus: 'CREATE_COMPLETE', Tags: [] }],
    });
    await expect(resumeFreshTeam(bootstrap.operationId, options)).rejects.toThrow(
      'Original ready team host',
    );
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('passes the complete declared Bedrock default/member/fallback union to the existing provider workflow', async () => {
    const mixed = parseTeamDefinition({
      ...definition,
      defaultModel: { primary: 'openrouter/auto', fallbacks: ['amazon-bedrock/fallback'] },
      members: [
        definition.members[0],
        { ...definition.members[1], model: 'amazon-bedrock/research' },
      ],
    });
    mocks.provider.mockResolvedValue({ routes: ['reviewed'] });
    await enableTeamBedrock(ctx, mixed, options);
    expect(mocks.provider).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        models: ['amazon-bedrock/fallback', 'amazon-bedrock/research'],
        allowRestart: true,
        acceptPluginCapabilities: true,
      }),
    );
    expect(mocks.providerApply).toHaveBeenCalledOnce();
    expect(mocks.providerCancel).not.toHaveBeenCalled();
  });
});
