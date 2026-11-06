import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock('../../src/aws/bedrock-routes.js', async (original) => ({
  ...(await original<object>()),
  resolveBedrockRoute: mocks.route,
}));
vi.mock('../../src/aws/bedrock-access.js', () => ({
  previewBedrockAccess: mocks.preview,
  applyBedrockAccess: mocks.apply,
  inspectBedrockAccess: mocks.inspect,
}));
import {
  prepareRecoveryBedrock,
  ensureRecoveryBedrockAccess,
  recoveryBedrockSummary,
  type RecoveryBedrockState,
} from '../../src/operations/recovery-bedrock.js';
import { parseBedrockRecoveryPlan } from '../../src/openclaw/bedrock-recovery-plan.js';
import { bedrockAccessStackName } from '../../src/aws/recovery-source.js';
import { BEDROCK_PLUGIN } from '../../src/openclaw/bedrock-configuration.js';
import { bedrockJob } from '../helpers/bedrock-operation.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
import type { BedrockRecoveryIntent } from '../../src/openclaw/bedrock-recovery-intent.js';
const ctx = makeCommandContext();
ctx.name = bedrockJob.target.deploymentName;
ctx.config.stack.name = 'OpenclawStack-test';
ctx.target = { ...ctx.target, region: 'eu-central-1' };
ctx.config.aws.region = ctx.target.region;
const source = {
  stackId: bedrockJob.target.stackId,
  instanceId: bedrockJob.target.instanceId,
  role: { id: bedrockJob.target.roleId, name: 'host', arn: 'arn:aws:iam::123456789012:role/host' },
  profile: { id: 'AIPAHOSTPROFILE000001', arn: 'arn:aws:iam::123456789012:instance-profile/host' },
};
const intent: BedrockRecoveryIntent = {
  authMode: 'instance-role',
  inferenceRegion: 'us-east-1',
  models: ['amazon-bedrock/provider.model'],
  plugin: BEDROCK_PLUGIN,
};
const route = {
  model: intent.models[0],
  region: intent.inferenceRegion,
  kind: 'foundation-model' as const,
  invocationArn: 'arn:aws:bedrock:us-east-1::foundation-model/provider.model',
  modelArns: ['arn:aws:bedrock:us-east-1::foundation-model/provider.model'],
};
const plan = { intent, selection: { discoveryRegion: intent.inferenceRegion, routes: [route] } };
const name = bedrockAccessStackName(source.stackId, source.role.id);
const access = {
  stackName: name,
  stackId: `arn:aws:cloudformation:eu-central-1:123456789012:stack/${name}/policy`,
  source,
  changeSetId: 'arn:aws:cloudformation:eu-central-1:123456789012:changeSet/recover/fixture',
  templateDigest: 'a'.repeat(64),
  noChanges: false,
};
let record: RecoveryBedrockState;
let saved: RecoveryBedrockState[];
const save = () => {
  saved.push(structuredClone(record));
};
const ensure = () =>
  ensureRecoveryBedrockAccess({ ctx, record, source, jobTarget: bedrockJob.target, save });
beforeEach(() => {
  vi.resetAllMocks();
  record = { bedrock: structuredClone(plan) };
  saved = [];
  mocks.route.mockResolvedValue(structuredClone(route));
  mocks.preview.mockResolvedValue(structuredClone(access));
  mocks.inspect.mockResolvedValue(structuredClone(plan.selection));
});
describe('fresh-target Bedrock recovery permissions', () => {
  it('resolves only exact saved model routes before provisioning and prints scoped approval details', async () => {
    await expect(prepareRecoveryBedrock(ctx, undefined)).resolves.toBeUndefined();
    expect(mocks.route).not.toHaveBeenCalled();
    expect(await prepareRecoveryBedrock(ctx, intent)).toEqual(plan);
    expect(mocks.route).toHaveBeenCalledWith(ctx.target, intent.models[0], intent.inferenceRegion);
    expect(recoveryBedrockSummary(plan)).toContain(route.invocationArn);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('persists reviewed then started intent before IAM execution, and records applied only after readback', async () => {
    mocks.apply.mockImplementation(async () => {
      expect(saved.map((state) => state.bedrockIam?.phase)).toEqual(['reviewed', 'started']);
    });
    await ensure();
    expect(saved.map((state) => state.bedrockIam?.phase)).toEqual([
      'reviewed',
      'started',
      'applied',
    ]);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(ctx, plan.selection, access);
    await ensure();
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledWith(ctx);
  });
  it('retains started intent after a lost IAM reply and only adopts an exactly verified applied policy on resume', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('uncertain write'));
    await expect(ensure()).rejects.toThrow(/uncertain write/);
    expect(record.bedrockIam?.phase).toBe('started');
    mocks.inspect.mockResolvedValueOnce(undefined);
    await expect(ensure()).rejects.toThrow(/no IAM write or Gateway activation was repeated/);
    expect(mocks.apply).toHaveBeenCalledOnce();
    await ensure();
    expect(record.bedrockIam?.phase).toBe('applied');
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
  it('does not execute IAM when its started-intent persistence fails', async () => {
    await expect(
      ensureRecoveryBedrockAccess({
        ctx,
        record,
        source,
        jobTarget: bedrockJob.target,
        save() {
          if (record.bedrockIam?.phase === 'started') throw new Error('journal persistence failed');
        },
      }),
    ).rejects.toThrow(/journal persistence/);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('awaits asynchronous persistence before IAM execution', async () => {
    let persisted = false;
    mocks.apply.mockImplementation(async () => {
      expect(persisted).toBe(true);
    });
    await ensureRecoveryBedrockAccess({
      ctx,
      record,
      source,
      jobTarget: bedrockJob.target,
      async save() {
        await Promise.resolve();
        if (record.bedrockIam?.phase === 'started') persisted = true;
      },
    });
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
  it('refuses a changed role/profile or drifted applied selection rather than activating under new authority', async () => {
    await ensure();
    const changed = { ...source, profile: { ...source.profile, id: 'AIPAOTHERPROFILE000001' } };
    await expect(
      ensureRecoveryBedrockAccess({
        ctx,
        record,
        source: changed,
        jobTarget: bedrockJob.target,
        save,
      }),
    ).rejects.toThrow(/role\/profile changed/);
    mocks.inspect.mockResolvedValueOnce({ ...plan.selection, routes: [] });
    await expect(ensure()).rejects.toThrow(/unconfirmed/);
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
  it('binds the complete saved model set and inference region to exact AWS routes', () => {
    const identity = { account: ctx.target.account, partition: 'aws' };
    for (const invalid of [
      { ...plan, selection: { ...plan.selection, routes: [] } },
      { ...plan, selection: { ...plan.selection, discoveryRegion: 'eu-central-1' } },
      { ...plan, privateKey: 'must-not-persist' },
    ])
      expect(() => parseBedrockRecoveryPlan(invalid, identity)).toThrow();
  });
});
