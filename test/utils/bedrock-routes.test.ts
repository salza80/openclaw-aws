import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetFoundationModelCommand, GetInferenceProfileCommand } from '@aws-sdk/client-bedrock';
import { testTarget } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), options: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock', async (load) => ({
  ...(await load<object>()),
  BedrockClient: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    send = mocks.send;
    destroy = mocks.destroy;
  },
}));
import {
  resolveBedrockRoute,
  validateBedrockRoute,
  type BedrockRoute,
} from '../../src/aws/bedrock-routes.js';
const region = 'eu-central-1';
const account = '123456789012';
const foundationArn = 'arn:aws:bedrock:eu-central-1::foundation-model/provider.model-v1:0';
const route = (): BedrockRoute => ({
  model: 'amazon-bedrock/provider.model-v1:0',
  region,
  kind: 'foundation-model',
  invocationArn: foundationArn,
  modelArns: [foundationArn],
});
const error = (name: string) => Object.assign(new Error('private service detail'), { name });
beforeEach(() => {
  vi.resetAllMocks();
});
describe('Bedrock IAM route metadata', () => {
  it('rejects known non-streaming foundation models before returning a provisioning/IAM route', async () => {
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof GetFoundationModelCommand)
        return { modelDetails: { modelArn: foundationArn, responseStreamingSupported: false } };
      throw error('ResourceNotFoundException');
    });
    await expect(resolveBedrockRoute(testTarget, route().model, region)).rejects.toMatchObject({
      kind: 'capability',
      message: expect.stringContaining('response streaming'),
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('resolves a bare foundation ID using read-only metadata and the selected target credentials', async () => {
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof GetFoundationModelCommand)
        return { modelDetails: { modelArn: foundationArn } };
      if (command instanceof GetInferenceProfileCommand) throw error('ResourceNotFoundException');
      throw new Error('Inference was not requested');
    });
    expect(await resolveBedrockRoute(testTarget, route().model, region)).toEqual(route());
    expect(mocks.options.mock.calls[0][0]).toMatchObject({
      region,
      credentials: testTarget.credentials,
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('uses exact profile and backing ARNs, including global routing, without deriving regions from the ID', async () => {
    const profileArn =
      'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.provider.model';
    const backing = [foundationArn.replace('eu-central-1', 'us-east-1'), foundationArn];
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof GetFoundationModelCommand) throw error('ResourceNotFoundException');
      return {
        inferenceProfileArn: profileArn,
        status: 'ACTIVE',
        models: backing.map((modelArn) => ({ modelArn })),
      };
    });
    const profile = await resolveBedrockRoute(
      testTarget,
      'amazon-bedrock/eu.provider.model',
      region,
    );
    expect(profile.kind).toBe('inference-profile');
    expect(profile.modelArns).toEqual(backing.toSorted());
    const global = {
      ...profile,
      invocationArn: profileArn.replace('eu.provider.model', 'global.provider.model'),
      model: 'amazon-bedrock/global.provider.model',
      modelArns: ['arn:aws:bedrock:::foundation-model/provider.model-v1:0'],
    };
    expect(validateBedrockRoute(global, { account, partition: 'aws' }).modelArns).toEqual(
      global.modelArns,
    );
  });
  it('accepts an explicitly selected application profile and queries only that metadata surface', async () => {
    const profileArn =
      'arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/copy-profile';
    mocks.send.mockResolvedValue({
      inferenceProfileArn: profileArn,
      status: 'ACTIVE',
      models: [{ modelArn: foundationArn }],
    });
    const profile = await resolveBedrockRoute(testTarget, 'amazon-bedrock/' + profileArn, region);
    expect(profile.kind).toBe('application-inference-profile');
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(GetInferenceProfileCommand);
  });
  it('refuses foreign identities, wildcard grants, guessed backing models and changed selections', () => {
    const changes: Partial<BedrockRoute>[] = [
      { invocationArn: foundationArn.replace('aws:bedrock', 'aws-cn:bedrock') },
      { invocationArn: foundationArn.replace('eu-central-1', 'us-east-1') },
      { invocationArn: foundationArn.replace('::foundation', ':999999999999:foundation') },
      { modelArns: [foundationArn.replace('provider.model-v1:0', '*')] },
      { modelArns: [foundationArn.replace('provider.model', 'other.model')] },
      { modelArns: [] },
      { model: 'amazon-bedrock/other.model-v1:0' },
    ];
    for (const change of changes)
      expect(() =>
        validateBedrockRoute({ ...route(), ...change }, { account, partition: 'aws' }),
      ).toThrow();
  });
  it('distinguishes denied metadata, invalid IDs and connectivity without publishing service errors', async () => {
    for (const [name, kind] of [
      ['AccessDeniedException', 'access'],
      ['ValidationException', 'identifier'],
      ['TimeoutError', 'connectivity'],
      ['ResourceNotFoundException', 'unavailable'],
    ]) {
      mocks.send.mockRejectedValue(error(name));
      const failure = await resolveBedrockRoute(testTarget, route().model, region).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ kind });
      expect(String(failure)).not.toContain('private service detail');
    }
  });
  it('rejects incomplete/nonactive metadata and explicit foreign ARNs, and honors cancellation', async () => {
    const arn = 'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.provider.model';
    mocks.send.mockResolvedValue({
      inferenceProfileArn: arn,
      status: 'INACTIVE',
      models: [{ modelArn: foundationArn }],
    });
    await expect(resolveBedrockRoute(testTarget, 'amazon-bedrock/' + arn, region)).rejects.toThrow(
      'not active',
    );
    mocks.send.mockClear();
    await expect(
      resolveBedrockRoute(
        testTarget,
        'amazon-bedrock/' + arn.replace(account, '999999999999'),
        region,
      ),
    ).rejects.toThrow('another account');
    const abort = new AbortController();
    abort.abort();
    await expect(
      resolveBedrockRoute(testTarget, route().model, region, abort.signal),
    ).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
