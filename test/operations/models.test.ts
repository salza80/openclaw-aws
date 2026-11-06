import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  root: '',
  source: vi.fn(),
  deliver: vi.fn(),
  has: vi.fn(),
  packaged: vi.fn(),
  execute: vi.fn(),
  lock: vi.fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({ getConfigRoot: () => mocks.root }));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/aws/model-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deliverModelArtifact: mocks.deliver,
  hasModelArtifact: mocks.has,
  packagedModelArtifact: mocks.packaged,
}));
vi.mock('../../src/aws/ssm.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeSsm: mocks.execute,
}));
vi.mock('../../src/aws/model-delivery.js', () => ({
  modelRemoteCommand: (request: unknown) => JSON.stringify(request),
}));
vi.mock('../../src/operations/lock.js', () => ({ withDeploymentLock: mocks.lock }));
import { createModelArtifact, modelArtifactFilenames } from '../../src/aws/model-artifact.js';
import { RemoteCommandError } from '../../src/aws/ssm.js';
import {
  queryModels,
  prepareModelChange,
  applyModelChange,
  inspectModelOperation,
  loadModelChange,
} from '../../src/operations/models.js';
import type { CommandContext } from '../../src/cli/utils/context.js';
import type { ModelJob } from '../../src/openclaw/model-contract.js';
import { modelJob } from '../helpers/model-operation.js';
import { loadDeploymentState } from '../../src/operations/state.js';
let home: string;
let source: {
  stackId: string;
  instanceId: string;
  role: { id: string };
  profile: { arn: string; id: string };
};
const ctx = {
  name: 'test',
  config: { stack: { name: 'OpenclawStack-test' }, aws: { region: 'eu-central-1' } },
  target: { account: modelJob.target.account, region: modelJob.target.region },
} as CommandContext;
function observation(job: ModelJob, selected = 'openrouter/old') {
  return {
    scope: job.scope,
    configHash: 'opaque:revision:0',
    configuredPrimary: selected,
    fallbackCount: 1,
    effectiveForNewSessions: selected,
    inherited: false,
    reloadOff: false,
    checkedAt: new Date().toISOString(),
    sessionSelections: 'preserved',
    inferenceVerified: false,
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(path.join(os.tmpdir(), 'model-controller-'));
  mocks.root = path.join(home, '.openclaw-aws');
  source = {
    stackId: modelJob.target.stackId,
    instanceId: modelJob.target.instanceId,
    role: { id: modelJob.target.roleId },
    profile: {
      arn: `arn:aws:iam::${modelJob.target.account}:instance-profile/host`,
      id: 'AIPATESTPROFILE000001',
    },
  };
  mocks.source.mockImplementation(async () => structuredClone(source));
  mocks.packaged.mockResolvedValue(
    createModelArtifact(
      modelArtifactFilenames.map((name) => ({ name, body: Buffer.from(`fixture ${name}`) })),
    ),
  );
  mocks.deliver.mockResolvedValue({});
  mocks.has.mockResolvedValue(true);
  mocks.lock.mockImplementation(async (_ctx, run) => run());
  mocks.execute.mockImplementation(async (_id, _target, commands: string[]) => {
    const { job, mode } = JSON.parse(commands[0]) as { job: ModelJob; mode: string };
    const header = {
      ok: true,
      schemaVersion: 1,
      operationId: job.operationId,
      stackId: job.target.stackId,
      instanceId: job.target.instanceId,
    };
    const result =
      mode !== 'execute'
        ? {
            ...header,
            phase: 'complete',
            maintenanceHeld: false,
            recordedAt: new Date().toISOString(),
            observed: observation(job, 'openrouter/new'),
            replayAllowed: false,
          }
        : job.action.kind === 'set'
          ? {
              ...header,
              phase: 'complete',
              ...observation(job, job.action.model),
              maintenanceHeld: false,
              restarted: false,
            }
          : { ...header, phase: 'observed', ...observation(job) };
    return { stdout: JSON.stringify(result), stderr: '', commandId: 'ssm-fixture' };
  });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const prepare = () =>
  prepareModelChange(ctx, {
    scope: modelJob.scope,
    model: 'openrouter/new',
    operationId: modelJob.operationId,
  });
describe('shared model operations', () => {
  it('previews native scope/revision and revalidates the same host/profile under the deployment lock before mutation', async () => {
    const original = structuredClone(ctx);
    const plan = await prepare();
    expect(plan.job).toEqual(modelJob);
    expect(plan.before).toMatchObject({ effectiveForNewSessions: 'openrouter/old' });
    expect(mocks.deliver).toHaveBeenCalledWith(
      source.instanceId,
      ctx.target,
      expect.any(Object),
      undefined,
    );
    const read = JSON.parse(mocks.execute.mock.calls[0][2][0]);
    expect(read.job.action.kind).toBe('current');
    expect(read.mode).toBe('execute');
    const delegate = mocks.execute.getMockImplementation()!;
    mocks.execute.mockImplementation(async (...args) => {
      const frame = JSON.parse(args[2][0]);
      if (frame.job.action.kind === 'set')
        expect(
          JSON.parse(
            await readFile(
              path.join(mocks.root, 'model-operations', modelJob.operationId, 'request.json'),
              'utf8',
            ),
          ),
        ).toEqual(plan);
      return delegate(...args);
    });
    const result = await applyModelChange(ctx, plan);
    expect(result).toMatchObject({ phase: 'complete', effectiveForNewSessions: 'openrouter/new' });
    expect(await loadModelChange(modelJob.operationId)).toEqual(plan);
    expect(loadDeploymentState(ctx)?.modelSelections?.agents.researcher.model).toBe(
      'openrouter/new',
    );
    expect(ctx).toEqual(original);
    expect(mocks.lock).toHaveBeenCalledTimes(2);
    expect(mocks.source).toHaveBeenCalledTimes(2);
    await expect(applyModelChange(ctx, plan)).rejects.toThrow(/already recorded/);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
  it.each(['stackId', 'instanceId', 'role', 'profile'] as const)(
    'refuses changed %s before saving intent or dispatching a model write',
    async (key) => {
      const plan = await prepare();
      mocks.execute.mockClear();
      if (key === 'role') source.role.id = 'AROAOTHERHOSTROLE00001';
      else if (key === 'profile') source.profile.id = 'AIPAOTHERPROFILE00001';
      else source[key] += '-changed';
      await expect(applyModelChange(ctx, plan)).rejects.toThrow(/changed after model preview/);
      expect(mocks.execute).not.toHaveBeenCalled();
      await expect(loadModelChange(modelJob.operationId)).rejects.toThrow();
    },
  );
  it('retains immutable intent on a lost SSM reply and inspects using exact original code/job without replay', async () => {
    const plan = await prepare();
    mocks.execute.mockRejectedValueOnce(
      new RemoteCommandError('private transport details', '12345678-1234-1234-1234-123456789abc'),
    );
    await expect(applyModelChange(ctx, plan)).rejects.toMatchObject({
      operationId: modelJob.operationId,
      commandId: '12345678-1234-1234-1234-123456789abc',
    });
    expect(await loadModelChange(modelJob.operationId)).toEqual(plan);
    expect(loadDeploymentState(ctx)?.modelSelections).toBeUndefined();
    const nextPlan = {
      ...plan,
      job: {
        ...plan.job,
        operationId: 'ab4d5841-6a97-4014-8596-d372d73c99af',
        scope: { kind: 'agent' as const, agentId: 'reviewer' },
      },
    };
    await expect(applyModelChange(ctx, nextPlan)).rejects.toThrow(/unresolved/);
    const observed = await inspectModelOperation(ctx, modelJob.operationId);
    expect(observed).toMatchObject({ phase: 'complete', maintenanceHeld: false });
    expect(loadDeploymentState(ctx)?.modelSelections).toBeUndefined();
    const request = JSON.parse(mocks.execute.mock.calls.at(-1)![2][0]);
    expect(request).toEqual({ job: plan.job, pin: plan.artifact, mode: 'inspect' });
    await expect(applyModelChange(ctx, plan)).rejects.toThrow(/already recorded/);
    expect(
      mocks.execute.mock.calls.filter((call) => {
        const frame = JSON.parse(call[2][0]);
        return frame.mode === 'execute' && frame.job.action.kind === 'set';
      }),
    ).toHaveLength(1);
    expect(await applyModelChange(ctx, nextPlan)).toMatchObject({ phase: 'complete' });
  });
  it('refuses another AWS target or absent original code without dispatching or substituting updated code', async () => {
    const plan = await prepare();
    await applyModelChange(ctx, plan);
    mocks.execute.mockClear();
    const other = { ...ctx, target: { ...ctx.target, account: '999999999999' } };
    await expect(inspectModelOperation(other, modelJob.operationId)).rejects.toThrow(
      /another deployment/,
    );
    mocks.has.mockResolvedValue(false);
    await expect(inspectModelOperation(ctx, modelJob.operationId)).rejects.toThrow(
      /Original pinned model worker is absent/,
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rejects native output carrying private fields and does not expose raw output in errors', async () => {
    const privateValue = 'fixture-key-never-publish';
    mocks.execute.mockResolvedValue({
      stdout: JSON.stringify({ ok: true, nativeAuth: privateValue }),
      stderr: '',
      commandId: 'fixture',
    });
    await expect(
      queryModels(ctx, { scope: modelJob.scope, action: { kind: 'current' } }),
    ).rejects.toThrow(/private output was not published/);
  });
  it('requires controlled restart consent at preview when native reload is off', async () => {
    const original = mocks.execute.getMockImplementation()!;
    mocks.execute.mockImplementation(async (...args) => {
      const result = await original(...args);
      return {
        ...result,
        stdout: JSON.stringify({ ...JSON.parse(result.stdout), reloadOff: true }),
      };
    });
    await expect(prepare()).rejects.toThrow(/--allow-restart/);
    expect(
      (
        await prepareModelChange(ctx, {
          scope: modelJob.scope,
          model: 'openrouter/new',
          allowRestart: true,
        })
      ).job.action,
    ).toMatchObject({ kind: 'set', allowRestart: true });
  });
});
