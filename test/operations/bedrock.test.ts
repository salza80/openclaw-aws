import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  root: '',
  source: vi.fn(),
  artifact: vi.fn(),
  has: vi.fn(),
  deliver: vi.fn(),
  execute: vi.fn(),
  union: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  discard: vi.fn(),
  inspectAccess: vi.fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({ getConfigRoot: () => mocks.root }));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/aws/model-artifact.js', async (original) => ({
  ...(await original<object>()),
  packagedModelArtifact: mocks.artifact,
  hasModelArtifact: mocks.has,
  deliverModelArtifact: mocks.deliver,
}));
vi.mock('../../src/aws/model-delivery.js', () => ({
  bedrockRemoteCommand: (value: unknown) => JSON.stringify(value),
}));
vi.mock('../../src/aws/ssm.js', async (original) => ({
  ...(await original<object>()),
  executeSsm: mocks.execute,
}));
vi.mock('../../src/aws/bedrock-access.js', () => ({
  planBedrockAccessExtension: mocks.union,
  previewBedrockAccess: mocks.preview,
  applyBedrockAccess: mocks.apply,
  discardBedrockAccessPreview: mocks.discard,
  inspectBedrockAccess: mocks.inspectAccess,
}));
vi.mock('../../src/operations/lock.js', () => ({
  withDeploymentLock: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}));
import { createModelArtifact, modelArtifactFilenames } from '../../src/aws/model-artifact.js';
import {
  prepareBedrockConnection,
  applyBedrockConnection,
  inspectBedrockConnection,
  cancelBedrockConnection,
  loadBedrockConnection,
} from '../../src/operations/bedrock.js';
import { controlFencePath, readControlFence } from '../../src/operations/control-fence.js';
import { bedrockJob } from '../helpers/bedrock-operation.js';
import type { BedrockJob } from '../../src/openclaw/bedrock-contract.js';
import type { CommandContext } from '../../src/cli/utils/context.js';
const source = {
  stackId: bedrockJob.target.stackId,
  instanceId: bedrockJob.target.instanceId,
  role: {
    id: bedrockJob.target.roleId,
    name: 'host',
    arn: `arn:aws:iam::${bedrockJob.target.account}:role/host`,
  },
  profile: {
    id: 'AIPATESTPROFILE000001',
    arn: `arn:aws:iam::${bedrockJob.target.account}:instance-profile/host`,
  },
};
const ctx = {
  name: bedrockJob.target.deploymentName,
  config: { stack: { name: 'OpenclawStack-test' }, aws: { region: 'eu-central-1' } },
  target: {
    account: bedrockJob.target.account,
    region: 'eu-central-1',
    arn: `arn:aws:sts::${bedrockJob.target.account}:assumed-role/operator/session`,
  },
} as CommandContext;
let home: string;
const observed = () => ({
  configHash: 'configured-revision',
  configured: true,
  pluginVerified: true,
  roleEnvironmentVerified: true,
  checkedAt: new Date().toISOString(),
});
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(path.join(os.tmpdir(), 'bedrock-controller-'));
  mocks.root = path.join(home, '.openclaw-aws');
  mocks.source.mockResolvedValue(structuredClone(source));
  mocks.has.mockResolvedValue(true);
  mocks.artifact.mockResolvedValue(
    createModelArtifact(modelArtifactFilenames.map((name) => ({ name, body: Buffer.from(name) }))),
  );
  mocks.union.mockImplementation(async (_ctx, value) => value);
  mocks.preview.mockResolvedValue({
    stackName: 'OpenclawBedrockAccess-fixture',
    stackId:
      'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawBedrockAccess-fixture/id',
    changeSetId: 'fixture-changeset',
    source,
    templateDigest: 'a'.repeat(64),
    noChanges: false,
  });
  mocks.execute.mockImplementation(async (_id, _target, commands) => {
    const { job, mode } = JSON.parse(commands[0]) as { job: BedrockJob; mode: string };
    const header = {
      ok: true,
      kind: job.kind,
      operationId: job.operationId,
      target: job.target,
      inferenceRegion: job.inferenceRegion,
      inferenceVerified: false,
      replayAllowed: false,
    };
    const result =
      mode === 'preview'
        ? {
            ...header,
            phase: 'preview',
            configHash: bedrockJob.expectedHash,
            unrelatedHash: 'b'.repeat(64),
            pluginInstalled: false,
          }
        : mode === 'inspect'
          ? {
              ...header,
              phase: 'complete',
              recordedAt: new Date().toISOString(),
              maintenanceHeld: false,
              observed: observed(),
            }
          : {
              ...header,
              phase: 'complete',
              maintenanceHeld: false,
              observed: observed(),
              ...(mode === 'accept-configured'
                ? { reconciled: true }
                : {
                    discovery: {
                      ready: true,
                      visibleModels: 2,
                      checkedAt: new Date().toISOString(),
                      inferenceVerified: false,
                    },
                  }),
            };
    return { stdout: JSON.stringify(result), stderr: '', commandId: 'fixture-ssm' };
  });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const prepare = () =>
  prepareBedrockConnection(ctx, {
    inferenceRegion: 'eu-central-1',
    allowRestart: true,
    acceptPluginCapabilities: true,
    operationId: bedrockJob.operationId,
  });
describe('shared Bedrock connection controller', () => {
  it('binds one native preview and exact IAM review, then persists intent/fence before IAM application or host writes', async () => {
    const plan = await prepare();
    expect(plan.job).toEqual(bedrockJob);
    expect(JSON.parse(mocks.execute.mock.calls[0][2][0]).job.operationId).not.toBe(
      plan.job.operationId,
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.apply.mockImplementation(async () => {
      expect(await loadBedrockConnection(plan.job.operationId)).toEqual(plan);
      expect(await readControlFence(plan.job.target)).toMatchObject({
        kind: 'bedrock-connection',
        operationId: plan.job.operationId,
      });
    });
    expect(await applyBedrockConnection(ctx, plan)).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
    });
    expect(mocks.apply).toHaveBeenCalledWith(ctx, plan.selection, plan.access, {
      signal: undefined,
    });
    expect(await readControlFence(plan.job.target)).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          path.join(mocks.root, 'bedrock-operations', plan.job.operationId, 'iam-applied.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ templateDigest: plan.access.templateDigest });
    await expect(applyBedrockConnection(ctx, plan)).rejects.toThrow();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
  it('retains an inspectable intent/fence after an uncertain IAM reply and does not dispatch the native mutation', async () => {
    const plan = await prepare();
    mocks.apply.mockRejectedValue(Error('private-cloudformation-output'));
    await expect(applyBedrockConnection(ctx, plan)).rejects.toThrow(/unconfirmed/);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(await readControlFence(plan.job.target)).toMatchObject({
      operationId: plan.job.operationId,
    });
    expect(await loadBedrockConnection(plan.job.operationId)).toEqual(plan);
    await expect(prepare()).rejects.toThrow(/unresolved/);
    await expect(applyBedrockConnection(ctx, plan)).rejects.toThrow(/unresolved/);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
  it('refuses missing applied IAM even for an empty discovery-only route union during configured-state acceptance', async () => {
    const plan = await prepare();
    mocks.apply.mockRejectedValue(Error('uncertain'));
    await expect(applyBedrockConnection(ctx, plan)).rejects.toThrow();
    mocks.inspectAccess.mockResolvedValue(undefined);
    await expect(
      inspectBedrockConnection(ctx, plan.job.operationId, { accept: 'configured' }),
    ).rejects.toThrow(/IAM grants/);
    expect(await readFile(controlFencePath(plan.job.target), 'utf8')).toContain(
      plan.job.operationId,
    );
    mocks.inspectAccess.mockResolvedValue(plan.selection);
    expect(
      await inspectBedrockConnection(ctx, plan.job.operationId, { accept: 'configured' }),
    ).toMatchObject({ phase: 'complete', reconciled: true });
    expect(await readControlFence(plan.job.target)).toBeUndefined();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
  it('refuses changed host/profile identities before applying policy and cancels only its exact review', async () => {
    const plan = await prepare();
    mocks.source.mockResolvedValue({ ...source, instanceId: 'i-fffffffffffffffff' });
    await expect(applyBedrockConnection(ctx, plan)).rejects.toThrow(/changed after preview/);
    expect(mocks.apply).not.toHaveBeenCalled();
    await cancelBedrockConnection(ctx, plan);
    expect(mocks.discard).toHaveBeenCalledWith(ctx, plan.access);
  });
});
