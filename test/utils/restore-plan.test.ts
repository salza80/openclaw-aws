import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { backupReceipt, backupId } from '../helpers/fixtures/backup.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  verify: vi.fn(),
  resolve: vi.fn(),
  presence: vi.fn(),
  namespace: vi.fn(),
  status: vi.fn(),
  capabilities: vi.fn(),
  region: vi.fn(),
  exists: vi.fn(),
  bedrockRoute: vi.fn(),
}));
vi.mock('../../src/operations/backup.js', async (load) => ({
  ...(await load<object>()),
  inspectBackup: mocks.inspect,
  verifyBackup: mocks.verify,
}));
vi.mock('../../src/aws/target.js', async (load) => ({
  ...(await load<object>()),
  resolveAwsTarget: mocks.resolve,
}));
vi.mock('../../src/aws/recovery-presence.js', () => ({ inspectRecoveryPresence: mocks.presence }));
vi.mock('../../src/aws/bedrock-routes.js', async (original) => ({
  ...(await original<object>()),
  resolveBedrockRoute: mocks.bedrockRoute,
}));
vi.mock('../../src/operations/deployment.js', () => ({
  assertRestoreSecretNamespace: mocks.namespace,
}));
vi.mock('../../src/cli/utils/aws.js', () => ({ getStackStatus: mocks.status }));
vi.mock('../../src/cli/utils/aws-validation.js', () => ({
  validateAWSRegion: mocks.region,
  validateInstanceCapabilities: mocks.capabilities,
}));
vi.mock('../../src/cli/utils/config.js', () => ({
  configExistsByName: mocks.exists,
  getConfigPathByName: (name: string) => `/fixture/.openclaw-aws/configs/${name}.json`,
  getConfigRoot: () => '/fixture/.openclaw-aws',
}));
import { prepareRestore } from '../../src/operations/restore.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
import { BEDROCK_PLUGIN } from '../../src/openclaw/bedrock-configuration.js';
const target = { ...makeCommandContext().target, region: 'eu-central-1', profile: 'recovery' };
const options = {
  recoveryTarget: target,
  vaultUri: backupReceipt.vaultUri,
  pointId: backupId,
  operationId: '22222222-2222-2222-2222-222222222222',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue(structuredClone(backupReceipt));
  mocks.resolve.mockResolvedValue(target);
  mocks.presence.mockResolvedValue({
    kind: 'gone',
    stack: 'deleted',
    archivedInstance: 'terminated',
  });
  mocks.status.mockRejectedValue(new StackNotFoundError('OpenclawStack-alpha', target.region));
  mocks.exists.mockReturnValue(false);
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
});
describe('fresh-client restore intake', () => {
  it('reviews saved Bedrock inference routes before any host exists and keeps AWS deployment/inference regions separate', async () => {
    const point = structuredClone(backupReceipt);
    const model = 'amazon-bedrock/provider.saved';
    point.capture.credentials.bedrock = {
      authMode: 'instance-role',
      inferenceRegion: 'us-east-1',
      models: [model],
      plugin: BEDROCK_PLUGIN,
    };
    mocks.inspect.mockResolvedValue(point);
    const arn = 'arn:aws:bedrock:us-east-1::foundation-model/provider.saved';
    mocks.bedrockRoute.mockResolvedValue({
      model,
      region: 'us-east-1',
      kind: 'foundation-model',
      invocationArn: arn,
      modelArns: [arn],
    });
    const plan = await prepareRestore(options);
    expect(plan.context.target.region).toBe('eu-central-1');
    expect(plan.bedrock?.intent).toEqual(point.capture.credentials.bedrock);
    expect(plan.prerequisites.join('\n')).toContain(arn);
    expect(mocks.bedrockRoute).toHaveBeenCalledWith(plan.context.target, model, 'us-east-1');
    expect(plan.context.config.openclaw).toBeUndefined();
  });
  it('reserves the downloaded archive alongside extracted data instead of trusting the old disk size alone', async () => {
    const point = structuredClone(backupReceipt);
    point.capture.capture.location.storedBytes = 20 * 1024 ** 3;
    point.capture.capture.location.plaintextBytes = 20 * 1024 ** 3 - 100;
    point.capture.objects[
      `backups/${point.job.namespace}/${point.capture.capture.location.key}`
    ].storedBytes = point.capture.capture.location.storedBytes;
    mocks.inspect.mockResolvedValue(point);
    expect((await prepareRestore(options)).bootstrap.volumeGiB).toBe(51);
    await expect(prepareRestore({ ...options, volumeGiB: 30 })).rejects.toThrow('at least 51');
  });
  it('defaults to the saved source region, type, name and recorded runtime after full verification', async () => {
    const plan = await prepareRestore(options);
    expect(plan.context.config).toMatchObject({
      instance: { type: 't3a.small' },
      aws: { region: target.region, profile: 'recovery' },
      stack: { name: 'OpenclawStack-alpha' },
    });
    expect(plan.bootstrap).toEqual({
      operationId: options.operationId,
      volumeGiB: 32,
      runtime: backupReceipt.capture.runtime,
    });
    expect(plan.context.config.openclaw).toBeUndefined(); // Native provider intent is inside encrypted state.
    expect(mocks.verify).toHaveBeenCalledWith(target, options.vaultUri, backupId);
    expect(mocks.namespace).toHaveBeenCalledWith(plan.context);
    expect(mocks.presence).toHaveBeenCalledWith(target, backupReceipt.job.source);
  });
  it('permits explicit same-account region/type overrides without changing the vault target', async () => {
    mocks.resolve.mockResolvedValue({ ...target, region: 'us-east-1' });
    const plan = await prepareRestore({
      ...options,
      name: 'new-claw',
      region: 'us-east-1',
      instanceType: 't3.medium',
      volumeGiB: 60,
    });
    expect(plan.context.name).toBe('new-claw');
    expect(plan.bootstrap.volumeGiB).toBe(60);
    expect(mocks.capabilities).toHaveBeenCalledWith('t3.medium', plan.context.target);
    expect(mocks.verify.mock.calls[0][0]).toBe(target);
  });
  it('refuses local or AWS collisions and denied namespace reads before native recovery work', async () => {
    mocks.exists.mockReturnValue(true);
    await expect(prepareRestore(options)).rejects.toThrow('local configuration');
    mocks.exists.mockReturnValue(false);
    mocks.status.mockResolvedValue({ stackId: 'existing' });
    await expect(prepareRestore(options)).rejects.toThrow('already exists');
    mocks.status.mockRejectedValue(new StackNotFoundError('alpha', target.region));
    mocks.namespace.mockRejectedValue(new Error('AccessDenied'));
    await expect(prepareRestore(options)).rejects.toThrow('AccessDenied');
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('refuses foreign accounts, incompatible pins, insufficient disk and corrupt or inaccessible recovery points', async () => {
    mocks.resolve.mockResolvedValue({ ...target, account: '999999999999' });
    await expect(prepareRestore(options)).rejects.toThrow('same AWS account');
    mocks.resolve.mockResolvedValue(target);
    await expect(prepareRestore({ ...options, volumeGiB: 29 })).rejects.toThrow();
    const point = structuredClone(backupReceipt);
    point.capture.runtime.openclaw = '2026.1.1';
    mocks.inspect.mockResolvedValue(point);
    await expect(prepareRestore(options)).rejects.toThrow('runtime');
    mocks.inspect.mockResolvedValue(structuredClone(backupReceipt));
    mocks.verify.mockRejectedValue(new Error('Invalid archive'));
    await expect(prepareRestore(options)).rejects.toThrow('Invalid archive');
  });
  it('reports a live source as a required fence, never as authorization to activate', async () => {
    mocks.presence.mockResolvedValue({
      kind: 'retained-host',
      instanceId: backupReceipt.job.source.instanceId,
      state: 'stopped',
    });
    const plan = await prepareRestore(options);
    expect(plan.sourcePresence.kind).toBe('retained-host');
    expect(plan.prerequisites.join(' ')).toContain('independent cloning');
  });
});
