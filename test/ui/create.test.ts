import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({
  root: '',
  exists: vi.fn(),
  save: vi.fn(),
  target: vi.fn(),
  stack: vi.fn(),
  capabilities: vi.fn(),
  bootstrap: vi.fn(),
  runBootstrap: vi.fn(),
  initial: vi.fn(),
  credentials: vi.fn(),
  deploy: vi.fn(),
}));
vi.mock('../../src/cli/utils/config.js', () => ({
  getConfigRoot: () => mocks.root,
  configExistsByName: mocks.exists,
  saveConfigByName: mocks.save,
  getConfigPathByName: (name: string) => path.join(mocks.root, name + '.json'),
}));
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: mocks.target }));
vi.mock('../../src/cli/utils/aws.js', () => ({ getStackStatus: mocks.stack }));
vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  validateInstanceCapabilities: mocks.capabilities,
  checkCDKBootstrap: mocks.bootstrap,
  runCDKBootstrap: mocks.runBootstrap,
}));
vi.mock('../../src/operations/fresh-bedrock.js', () => ({
  prepareInitialBedrock: mocks.initial,
  initialBedrockSummary: () =>
    'Pinned plugin and scoped invocation route\nInvoke: arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.amazon.nova-micro-v1:0',
}));
vi.mock('../../src/operations/credential-references.js', () => ({
  resolveCredentialReferences: mocks.credentials,
}));
vi.mock('../../src/operations/deployment.js', () => ({ deployDeployment: mocks.deploy }));
import { prepareUiCreate } from '../../src/ui/create.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
import { parseUiPlanView } from '../../src/ui/public.js';
import type { UiActionRequest, UiPlanView } from '../../src/ui/contracts.js';
const id = 'a1000000-0000-4000-8000-000000000001';
const target = {
  account: '123456789012',
  region: 'eu-central-1',
  environment: async () => ({ AWS_SECRET_ACCESS_KEY: 'PRIVATE-AWS-KEY' }),
};
const input: UiActionRequest = {
  action: 'create',
  name: 'alpha',
  region: target.region,
  provider: 'openrouter-api-key',
  credentials: [{ provider: 'openrouter-api-key', kind: 'env', reference: 'EXPLICIT_ROUTER_KEY' }],
};
const view = (): UiPlanView => ({
  id,
  action: 'create',
  title: 'Create',
  createdAt: new Date().toISOString(),
  target: { name: 'alpha', account: target.account, region: target.region },
  facts: [],
  effects: [],
});
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.root = await mkdtemp(path.join(tmpdir(), 'openclaw-ui-create-'));
  mocks.exists.mockReturnValue(false);
  mocks.target.mockResolvedValue(target);
  mocks.stack.mockRejectedValue(new StackNotFoundError('OpenclawStack-alpha', target.region));
  mocks.bootstrap.mockResolvedValue({ meetsMinimum: true });
  mocks.credentials.mockResolvedValue({ 'openrouter-api-key': 'PRIVATE-ROUTER-KEY' });
  mocks.deploy.mockResolvedValue({
    DeploymentId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/alpha/id',
    InstanceId: 'i-0123456789abcdef0',
  });
});
afterEach(async () => {
  await rm(mocks.root, { recursive: true, force: true });
});
describe('fresh UI provisioning review', () => {
  it('preserves multiline Bedrock route/plugin approvals while rejecting terminal controls', async () => {
    mocks.initial.mockResolvedValue({ deploymentName: 'alpha' });
    const operation = await prepareUiCreate(
      {
        ...input,
        provider: 'amazon-bedrock',
        model: 'amazon-bedrock/eu.amazon.nova-micro-v1:0',
        bedrockRegion: target.region,
        credentials: [],
      },
      view(),
    );
    const review = parseUiPlanView(operation.view);
    expect(review.facts.find((fact) => fact.label === 'Bedrock approval')?.value).toContain(
      '\nInvoke: arn:aws:bedrock:',
    );
    expect(() =>
      parseUiPlanView({
        ...operation.view,
        facts: [{ label: 'Invalid', value: 'control\u001b[31m' }],
      }),
    ).toThrow('Invalid public UI fact text');
    expect(mocks.deploy).not.toHaveBeenCalled();
  });
  it('resolves reference values only after approval and uses the shared deployment operation', async () => {
    const operation = await prepareUiCreate(input, view());
    expect(JSON.stringify(parseUiPlanView(operation.view))).not.toContain('PRIVATE-');
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    await operation.apply(() => {});
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ instance: { type: 't3a.small', name: 'openclaw-alpha' } }),
      'alpha',
      { overwrite: false },
    );
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alpha', target }),
      expect.objectContaining({ apiProvider: 'openrouter-api-key', apiKey: 'PRIVATE-ROUTER-KEY' }),
    );
  });
  it('refuses a named stack appearing between review and apply', async () => {
    const operation = await prepareUiCreate(input, view());
    mocks.stack.mockResolvedValue({ stackId: 'replacement' });
    await expect(operation.apply(() => {})).rejects.toThrow('already exists');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });
  it('includes CDK bootstrap in the review and does not perform it before apply', async () => {
    mocks.bootstrap.mockResolvedValue({ meetsMinimum: false });
    const operation = await prepareUiCreate(input, view());
    expect(operation.view.effects.join(' ')).toContain('shared CDK bootstrap');
    expect(mocks.runBootstrap).not.toHaveBeenCalled();
    await operation.apply(() => {});
    expect(mocks.runBootstrap).toHaveBeenCalledWith(target.account, target);
  });
  it('records team creation identity and passes it to the separate native-team review', async () => {
    const definition = {
      schemaVersion: 1,
      topology: 'single-host',
      coordinator: 'lead',
      members: [
        { id: 'lead', role: 'Coordinator', instructions: 'Coordinate.' },
        { id: 'researcher', role: 'Research', instructions: 'Research.' },
      ],
    };
    const operation = await prepareUiCreate(
      { ...input, action: 'team-create', definition },
      { ...view(), action: 'team-create' },
    );
    const result = await operation.apply(() => {});
    const saved = JSON.parse(
      await readFile(path.join(mocks.root, 'team-create', id, 'request.json'), 'utf8'),
    );
    expect(result.recovery?.[0]).toMatchObject({
      action: 'team-configure',
      name: 'alpha',
      teamId: saved.teamId,
    });
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ team: { teamId: saved.teamId, operationId: id, providers: [] } }),
    );
    expect(JSON.stringify(saved)).not.toContain('PRIVATE-');
  });
});
