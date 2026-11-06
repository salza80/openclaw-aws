import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backupReceipt } from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
  namespace: vi.fn(),
  capabilities: vi.fn(),
  region: vi.fn(),
  presence: vi.fn(),
  bedrock: vi.fn(),
}));
vi.mock('../../src/operations/recovery-bedrock.js', async (load) => ({
  ...(await load<object>()),
  prepareRecoveryBedrock: mocks.bedrock,
}));
vi.mock('../../src/operations/clone-preview.js', () => ({ previewSavedClone: mocks.preview }));
vi.mock('../../src/aws/target.js', async (load) => ({
  ...(await load<object>()),
  resolveAwsTarget: mocks.resolve,
}));
vi.mock('../../src/aws/recovery-presence.js', () => ({ inspectRecoveryPresence: mocks.presence }));
vi.mock('../../src/operations/deployment.js', () => ({
  assertRestoreSecretNamespace: mocks.namespace,
}));
vi.mock('../../src/cli/utils/aws.js', () => ({ getStackStatus: mocks.status }));
vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  validateAWSRegion: mocks.region,
  validateInstanceCapabilities: mocks.capabilities,
}));
vi.mock('../../src/cli/utils/config.js', () => ({
  configExistsByName: () => false,
  getConfigPathByName: (name: string) => `/fixture/configs/${name}.json`,
  getConfigRoot: () => '/fixture',
}));
import { prepareClone } from '../../src/operations/clone.js';
import { cloneBedrockPlan } from '../helpers/fixtures/clone.js';
const options = () => ({
  recoveryTarget: testTarget,
  vaultUri: backupReceipt.vaultUri,
  pointId: backupReceipt.id,
  name: 'copy',
  apiProvider: 'openrouter-api-key' as const,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(testTarget);
  mocks.status.mockRejectedValue(new StackNotFoundError('OpenclawStack-copy'));
  const scope = (root: string) => ({
    root,
    files: [{ path: 'file', bytes: 1024 ** 3, sha256: 'a'.repeat(64) }],
    omitted: [],
  });
  mocks.preview.mockResolvedValue({
    point: structuredClone(backupReceipt),
    preview: {
      schemaVersion: 1,
      scope: 'whole-team-knowledge',
      providersInUse: ['openrouter'],
      policyDigest: 'b'.repeat(64),
      policy: { schemaVersion: 1, agents: [{ id: 'main' }], credentialPaths: [], omissions: [] },
      content: {
        schemaVersion: 1,
        digest: 'c'.repeat(64),
        members: [
          {
            id: 'main',
            workspace: '/home/ubuntu/.openclaw/workspaces/main',
            agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
            files: scope('').files,
            omitted: [],
            workshopSkills: scope('/home/ubuntu/.openclaw/agents/main/agent/workshop-skills'),
          },
        ],
        sharedSkills: scope('/home/ubuntu/.openclaw/skills'),
      },
    },
  });
});
describe('inactive independent clone planning', () => {
  it('resolves only selected policy routes for keyless clones, excluding saved conversation-only grants', async () => {
    const value = await mocks.preview();
    const bedrock = cloneBedrockPlan();
    value.point.capture.credentials.bedrock = {
      ...bedrock.intent,
      models: [...bedrock.intent.models, 'amazon-bedrock/anthropic.old-session-v1:0'],
    };
    value.preview.policy.model = { primary: bedrock.intent.models[0] };
    value.preview.providersInUse = ['amazon-bedrock'];
    mocks.preview.mockResolvedValue(value);
    mocks.bedrock.mockResolvedValue(bedrock);
    const plan = await prepareClone({ ...options(), apiProvider: 'amazon-bedrock' });
    expect(plan.bedrock).toEqual(bedrock);
    expect(plan.context.config.openclaw).toEqual({
      apiProvider: 'amazon-bedrock',
      authMode: 'instance-role',
      bedrock: { region: 'eu-central-1' },
    });
    expect(mocks.bedrock.mock.calls[0][1].models).toEqual(bedrock.intent.models);
  });
  it('requires explicit Cloudflare endpoint setup before provisioning a mixed-provider clone', async () => {
    const value = await mocks.preview();
    value.preview.providersInUse = ['cloudflare-ai-gateway', 'openrouter'];
    mocks.preview.mockResolvedValue(value);
    await expect(prepareClone(options())).rejects.toThrow('primary clone provider');
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it('allows a live source and reserves space for extracted source plus all selected workspace/skill copies', async () => {
    const before = JSON.stringify(backupReceipt);
    const plan = await prepareClone(options());
    expect(plan.bootstrap.operationId).toBe(plan.operationId);
    expect(plan.bootstrap.volumeGiB).toBe(35);
    expect(plan.context.config.stack.name).toBe('OpenclawStack-copy');
    expect(plan.context.config.openclaw?.apiProvider).toBe('openrouter-api-key');
    expect(mocks.presence).not.toHaveBeenCalled();
    expect(JSON.stringify(backupReceipt)).toBe(before);
    await expect(prepareClone({ ...options(), volumeGiB: 34 })).rejects.toThrow('at least 35');
  });
  it('rejects invalid names and missing explicit provider setup before decrypting the source', async () => {
    await expect(prepareClone({ ...options(), name: '../../source' })).rejects.toThrow();
    await expect(
      prepareClone({ ...options(), apiProvider: 'cloudflare-ai-gateway-api-key' }),
    ).rejects.toThrow('both account');
    expect(mocks.preview).not.toHaveBeenCalled();
    await expect(
      prepareClone({
        ...options(),
        apiProvider: 'cloudflare-ai-gateway-api-key',
        cloudflareAccountId: 'invalid',
        cloudflareGatewayId: 'valid-gateway',
      }),
    ).rejects.toThrow('32 hex');
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it('refuses target collisions and cross-account provisioning after preview without creating any resources', async () => {
    mocks.status.mockResolvedValue({ stackStatus: 'CREATE_COMPLETE' });
    await expect(prepareClone(options())).rejects.toThrow('already exists');
    mocks.resolve.mockResolvedValue({ ...testTarget, account: '999999999999' });
    await expect(prepareClone(options())).rejects.toThrow('same AWS account');
    expect(mocks.namespace).not.toHaveBeenCalled();
  });
});
