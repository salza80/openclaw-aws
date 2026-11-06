import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
import { BEDROCK_PLUGIN } from '../../src/openclaw/bedrock-configuration.js';
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  providerPreview: vi.fn(),
  providerApply: vi.fn(),
  providerCancel: vi.fn(),
  modelPreview: vi.fn(),
  modelApply: vi.fn(),
  modelCancel: vi.fn(),
}));
vi.mock('../../src/aws/bedrock-routes.js', async (original) => ({
  ...(await original<object>()),
  resolveBedrockRoute: mocks.route,
}));
vi.mock('../../src/operations/bedrock.js', () => ({
  prepareBedrockConnection: mocks.providerPreview,
  applyBedrockConnection: mocks.providerApply,
  cancelBedrockConnection: mocks.providerCancel,
}));
vi.mock('../../src/operations/models.js', () => ({
  prepareModelChange: mocks.modelPreview,
  applyModelChange: mocks.modelApply,
  cancelModelChange: mocks.modelCancel,
}));
import {
  prepareInitialBedrock,
  parseInitialBedrock,
  finishInitialBedrock,
  initialBedrockSummary,
} from '../../src/operations/fresh-bedrock.js';
const ctx = makeCommandContext();
ctx.config.instance.type = 't3a.small';
ctx.config.openclaw = {
  apiProvider: 'amazon-bedrock',
  authMode: 'instance-role',
  bedrock: { region: 'eu-central-1' },
  model: 'amazon-bedrock/provider.model',
};
const route = {
  model: 'amazon-bedrock/provider.model',
  region: 'eu-central-1',
  kind: 'foundation-model' as const,
  invocationArn: 'arn:aws:bedrock:eu-central-1::foundation-model/provider.model',
  modelArns: ['arn:aws:bedrock:eu-central-1::foundation-model/provider.model'],
};
const target = {
  deploymentName: ctx.name,
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/OpenclawStack-alpha/host',
  instanceId: 'i-1234567890abcdef0',
  roleId: 'AROAHOSTROLE000000001',
  account: ctx.target.account,
  region: ctx.target.region,
};
const outputs = { DeploymentId: target.stackId, InstanceId: target.instanceId };
const selection = { discoveryRegion: 'eu-central-1', routes: [route] };
const profile = {
  arn: 'arn:aws:iam::123456789012:instance-profile/host',
  id: 'AIPAHOST000000000001',
};
const providerPlan = () => ({
  job: { target, operationId: '11111111-1111-1111-1111-111111111111' },
  selection,
  profile,
});
const modelPlan = () => ({
  job: { target, operationId: '22222222-2222-2222-2222-222222222222' },
  bedrock: { selection },
  profile,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.route.mockResolvedValue(structuredClone(route));
  mocks.providerPreview.mockResolvedValue(structuredClone(providerPlan()));
  mocks.modelPreview.mockResolvedValue(structuredClone(modelPlan()));
  mocks.providerApply.mockResolvedValue({ phase: 'complete' });
  mocks.modelApply.mockResolvedValue({ phase: 'complete' });
});
describe('fresh Bedrock completion through shared operations', () => {
  it('previews exact metadata in the inference region and leaves API-key providers on their existing path', async () => {
    await expect(prepareInitialBedrock(makeCommandContext())).resolves.toBeUndefined();
    expect(mocks.route).not.toHaveBeenCalled();
    const plan = await prepareInitialBedrock(ctx);
    expect(mocks.route).toHaveBeenCalledWith(ctx.target, route.model, route.region);
    expect(plan).toMatchObject({
      account: ctx.target.account,
      deploymentRegion: 'us-east-1',
      inferenceRegion: 'eu-central-1',
      route,
      plugin: BEDROCK_PLUGIN,
    });
    expect(initialBedrockSummary(plan!)).toContain(route.invocationArn);
    expect(mocks.providerApply).not.toHaveBeenCalled();
  });
  it.each(['account', 'deploymentRegion', 'deploymentName', 'inferenceRegion', 'plugin', 'route'])(
    'refuses changed %s in the reviewed plan',
    async (field) => {
      const plan = (await prepareInitialBedrock(ctx))!;
      expect(() => parseInitialBedrock({ ...plan, [field]: 'changed' }, ctx)).toThrow();
      expect(mocks.providerPreview).not.toHaveBeenCalled();
    },
  );
  it('finishes provider first, then selects the model with the same role/profile and preserves setup provenance', async () => {
    const before = structuredClone(ctx.config);
    const plan = (await prepareInitialBedrock(ctx))!;
    const progress = vi.fn();
    mocks.providerApply.mockImplementation(async () => {
      expect(mocks.modelPreview).not.toHaveBeenCalled();
      return { phase: 'complete' };
    });
    await finishInitialBedrock(ctx, outputs, plan, progress);
    expect(mocks.providerPreview).toHaveBeenCalledWith(ctx, {
      inferenceRegion: route.region,
      models: [route.model],
      allowRestart: true,
      acceptPluginCapabilities: true,
    });
    expect(mocks.modelPreview).toHaveBeenCalledWith(ctx, {
      scope: { kind: 'default' },
      model: route.model,
      allowRestart: true,
    });
    expect(mocks.modelApply).toHaveBeenCalledWith(ctx, modelPlan());
    expect(ctx.config).toEqual(before);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(mocks.providerCancel).not.toHaveBeenCalled();
    expect(mocks.modelCancel).not.toHaveBeenCalled();
  });
  it.each(['instance', 'backing-route'])(
    'cancels the unexecuted provider review if approved %s changes',
    async (change) => {
      const plan = (await prepareInitialBedrock(ctx))!;
      const next = structuredClone(providerPlan());
      if (change === 'instance') next.job.target.instanceId = 'i-other';
      else
        next.selection.routes[0].modelArns.push(
          'arn:aws:bedrock:us-west-2::foundation-model/other',
        );
      mocks.providerPreview.mockResolvedValue(next);
      await expect(finishInitialBedrock(ctx, outputs, plan)).rejects.toThrow(
        /changed after approval/,
      );
      expect(mocks.providerCancel).toHaveBeenCalledWith(ctx, next);
      expect(mocks.providerApply).not.toHaveBeenCalled();
      expect(mocks.modelPreview).not.toHaveBeenCalled();
    },
  );
  it.each(['target', 'profile', 'region', 'route', 'missing-grants'])(
    'cancels the unexecuted model review when %s differs from the approved connection',
    async (change) => {
      const plan = (await prepareInitialBedrock(ctx))!;
      const next = structuredClone(modelPlan());
      if (change === 'target') next.job.target.roleId = 'AROAOTHERROLE000000001';
      if (change === 'profile') next.profile.id = 'AIPAOTHERPROFILE000001';
      if (change === 'region') next.bedrock.selection.discoveryRegion = 'us-west-2';
      if (change === 'route') next.bedrock.selection.routes[0].modelArns.push('changed');
      if (change === 'missing-grants') Reflect.deleteProperty(next, 'bedrock');
      mocks.modelPreview.mockResolvedValue(next);
      await expect(finishInitialBedrock(ctx, outputs, plan)).rejects.toThrow(/no model write/);
      expect(mocks.providerApply).toHaveBeenCalledOnce();
      expect(mocks.modelApply).not.toHaveBeenCalled();
      expect(mocks.modelCancel).toHaveBeenCalledWith(ctx, next);
    },
  );
  it.each(['provider', 'model'])(
    'does not report ready or cancel/retry an uncertain %s write',
    async (step) => {
      const plan = (await prepareInitialBedrock(ctx))!;
      (step === 'provider' ? mocks.providerApply : mocks.modelApply).mockResolvedValue({
        phase: 'uncertain',
      });
      await expect(finishInitialBedrock(ctx, outputs, plan)).rejects.toThrow(
        /inspect .*operation .*not ready/,
      );
      expect(mocks.providerApply).toHaveBeenCalledOnce();
      expect(mocks.modelApply).toHaveBeenCalledTimes(step === 'model' ? 1 : 0);
      expect(mocks.providerCancel).not.toHaveBeenCalled();
      expect(mocks.modelCancel).not.toHaveBeenCalled();
    },
  );
});
