import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({
  root: '',
  source: vi.fn(),
  packaged: vi.fn(),
  deliver: vi.fn(),
  has: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({ getConfigRoot: () => mocks.root }));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/aws/model-artifact.js', async (original) => ({
  ...(await original<object>()),
  packagedModelArtifact: mocks.packaged,
  deliverModelArtifact: mocks.deliver,
  hasModelArtifact: mocks.has,
}));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: mocks.execute }));
vi.mock('../../src/aws/model-delivery.js', () => ({
  teamRemoteCommand: (request: unknown) => JSON.stringify(request),
}));
vi.mock('../../src/operations/lock.js', () => ({
  withDeploymentLock: async (_ctx: unknown, run: () => unknown) => run(),
}));
vi.mock('../../src/operations/state.js', () => ({ loadDeploymentState: () => undefined }));
import { createModelArtifact, modelArtifactFilenames } from '../../src/aws/model-artifact.js';
import {
  prepareTeam,
  applyTeam,
  inspectTeamOperation,
  queryTeam,
} from '../../src/operations/teams.js';
import { readTeamState } from '../../src/operations/team-state.js';
import { readControlFence } from '../../src/operations/control-fence.js';
import {
  teamDefinitionDigest,
  parseTeamDefinition,
  teamMembers,
} from '../../src/openclaw/team-definition.js';
import type { TeamJob } from '../../src/openclaw/team-contract.js';
import type { CommandContext } from '../../src/cli/utils/context.js';
import { modelJob } from '../helpers/model-operation.js';
let home: string;
const ctx = {
  name: 'test',
  config: { stack: { name: 'OpenclawStack-test' } },
  target: { account: modelJob.target.account, region: modelJob.target.region },
} as CommandContext;
const definition = parseTeamDefinition({
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Coordinator', instructions: 'Collect replies.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research.' },
  ],
});
const main = {
  id: 'main',
  workspace: '/home/ubuntu/.openclaw/workspace',
  agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
};
const source = {
  stackId: modelJob.target.stackId,
  instanceId: modelJob.target.instanceId,
  role: { id: modelJob.target.roleId },
  profile: {
    arn: `arn:aws:iam::${modelJob.target.account}:instance-profile/host`,
    id: 'AIPATESTPROFILE000001',
  },
};
beforeEach(async () => {
  vi.resetAllMocks();
  home = await mkdtemp(path.join(os.tmpdir(), 'team-app-'));
  mocks.root = path.join(home, '.openclaw-aws');
  mocks.source.mockResolvedValue(structuredClone(source));
  mocks.packaged.mockResolvedValue(
    createModelArtifact(
      modelArtifactFilenames.map((name) => ({ name, body: Buffer.from(`fixture ${name}`) })),
    ),
  );
  mocks.has.mockResolvedValue(true);
  mocks.execute.mockImplementation(async (_id, _target, commands: string[]) => {
    const { job } = JSON.parse(commands[0]) as { job: TeamJob };
    const members = teamMembers(job.definition, '/home/ubuntu', main);
    const preview = job.action.kind === 'preview',
      status = job.action.kind === 'status';
    if (!preview && !status)
      expect(await readControlFence(job.target)).toMatchObject({
        kind: 'native-team',
        operationId: job.operationId,
      });
    return {
      stdout: JSON.stringify({
        ok: true,
        schemaVersion: 1,
        operationId: job.operationId,
        teamId: job.teamId,
        stackId: job.target.stackId,
        instanceId: job.target.instanceId,
        definitionDigest: teamDefinitionDigest(job.definition),
        inferenceVerified: false,
        recordedPhase: preview ? 'preview' : status ? 'observed' : 'complete',
        checkedAt: new Date().toISOString(),
        gatewayHealthy: true,
        requestedConfigurationVerified: !preview && !status,
        maintenanceHeld: false,
        members,
        ...(preview
          ? {
              preflight: {
                expectedHash: 'opaque:revision',
                existingMembers: [main],
                instructions: members.map((member) => ({ agentId: member.id, sha256: null })),
                reloadOff: false,
              },
            }
          : status
            ? {
                models: members.map((member) => ({
                  agentId: member.id,
                  model: 'openrouter/later-native-selection',
                })),
              }
            : { configHash: 'opaque:complete' }),
      }),
      stderr: '',
      commandId: 'fixture',
    };
  });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe('shared team application lifecycle', () => {
  it('binds a full native preview and saves only confirmed team ownership after apply', async () => {
    const plan = await prepareTeam(ctx, { definition });
    expect(await readControlFence(plan.job.target)).toBeUndefined();
    await expect(applyTeam(ctx, plan)).resolves.toMatchObject({
      recordedPhase: 'complete',
      inferenceVerified: false,
    });
    expect(await readControlFence(plan.job.target)).toBeUndefined();
    expect(await readTeamState(ctx.name)).toMatchObject({
      teamId: plan.job.teamId,
      target: plan.job.target,
    });
  });
  it('retains the original request/fence after SSM uncertainty and resumes without provisioning', async () => {
    const plan = await prepareTeam(ctx, { definition });
    mocks.execute.mockRejectedValueOnce(new Error('Lost SSM reply'));
    await expect(applyTeam(ctx, plan)).rejects.toThrow('Lost SSM reply');
    expect(await readControlFence(plan.job.target)).toMatchObject({
      operationId: plan.job.operationId,
    });
    await expect(prepareTeam(ctx, { definition })).rejects.toThrow('pending');
    await expect(
      inspectTeamOperation(ctx, plan.job.operationId, { mode: 'resume' }),
    ).resolves.toMatchObject({ result: { recordedPhase: 'complete' } });
    expect(JSON.parse(mocks.execute.mock.calls.at(-1)![2][0]).mode).toBe('resume');
    expect(await readControlFence(plan.job.target)).toBeUndefined();
  });
  it('refuses a replaced host before dispatching setup', async () => {
    const plan = await prepareTeam(ctx, { definition });
    mocks.source.mockResolvedValue({ ...source, instanceId: 'i-00000000000000000' });
    await expect(applyTeam(ctx, plan)).rejects.toThrow('identity changed');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('reports current native selections without replaying the original model definition', async () => {
    const plan = await prepareTeam(ctx, { definition });
    await applyTeam(ctx, plan);
    const result = await queryTeam(ctx);
    expect(result.models?.map((model) => model.model)).toEqual([
      'openrouter/later-native-selection',
      'openrouter/later-native-selection',
    ]);
    expect(result.requestedConfigurationVerified).toBe(false);
    expect(result.pendingControl).toBeNull();
    expect(JSON.parse(mocks.execute.mock.calls.at(-1)![2][0]).job.action.kind).toBe('status');
  });
  it('withholds unknown/private result fields and retains uncertainty', async () => {
    const plan = await prepareTeam(ctx, { definition });
    mocks.execute.mockResolvedValueOnce({
      stdout: JSON.stringify({ privateKey: 'DO-NOT-ECHO' }),
      stderr: '',
    });
    await expect(applyTeam(ctx, plan)).rejects.toThrow('private worker output was withheld');
    expect(await readControlFence(plan.job.target)).toBeDefined();
  });
});
