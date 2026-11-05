import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  put: vi.fn(),
  close: vi.fn(),
  secrets: vi.fn(),
  destroy: vi.fn(),
  validate: vi.fn(),
  stack: vi.fn(),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-secrets-manager')>()),
  SecretsManagerClient: class {
    send = mocks.secrets;
    destroy = mocks.destroy;
  },
}));
vi.mock('../../src/aws/recovery-store.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/recovery-store.js')>()),
  recoveryStore: () => ({ read: mocks.read, putImmutable: mocks.put, close: mocks.close }),
}));
vi.mock('../../src/aws/vault-security.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/vault-security.js')>()),
  validateVaultSecurity: mocks.validate,
}));
vi.mock('../../src/aws/auxiliary-stacks.js', () => ({ ensureRecoveryStack: mocks.stack }));
import {
  createRecoveryVault,
  parseRecoveryVault,
  readRecoveryVault,
  recoveryPassphrase,
  registerRecoveryVault,
  vaultId,
} from '../../src/operations/vault.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const target = {
  ...testTarget,
  region: 'eu-central-1',
  arn: 'arn:aws:iam::123456789012:role/operator',
};
const uri = 's3://private-backups/vault/main';
const keyArn = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:independent-abcdef';
const versionId = '11111111-1111-1111-1111-111111111111';
const id = vaultId(target, uri, keyArn);
const vault = {
  schemaVersion: 1,
  kind: 'openclaw-aws-vault',
  id,
  uri,
  account: target.account,
  region: target.region,
  createdAt: '2026-11-05T00:00:00.000Z',
  key: { arn: keyArn, versionId, versionStage: `openclaw-aws-vault-${id}` },
  encryption: {},
  retention: 'indefinite',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.validate.mockResolvedValue({});
  mocks.read.mockResolvedValue(undefined);
  mocks.secrets.mockImplementation(async (command) => {
    if (command instanceof DescribeSecretCommand) return { ARN: keyArn, VersionIdsToStages: {} };
    if (command instanceof GetSecretValueCommand)
      return { ARN: keyArn, VersionId: versionId, SecretString: 'fixture-private-passphrase' };
    return {};
  });
});
describe('independent recovery vault registration', () => {
  it('pins a retained key version before committing nonsecret vault identity metadata', async () => {
    const result = await registerRecoveryVault(target, { uri, keyArn });
    expect(result).toMatchObject({ ...vault, createdAt: expect.any(String) });
    const pin = mocks.secrets.mock.calls.find(
      ([command]) => command instanceof UpdateSecretVersionStageCommand,
    )![0];
    expect(pin.input).toEqual({
      SecretId: keyArn,
      VersionStage: vault.key.versionStage,
      MoveToVersionId: versionId,
    });
    expect(pin.input).not.toHaveProperty('RemoveFromVersionId');
    expect(
      mocks.secrets.mock.invocationCallOrder.find(
        (order) => order > mocks.read.mock.invocationCallOrder[0],
      ),
    ).toBeLessThan(mocks.put.mock.invocationCallOrder[0]);
    const stored = mocks.put.mock.calls[0];
    expect(stored[0]).toBe('vault.json');
    expect(JSON.stringify(stored[1])).not.toContain('fixture-private-passphrase');
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it('reuses a previously pinned version instead of moving it to a rotated current key', async () => {
    mocks.secrets.mockImplementation(async (command) => {
      if (command instanceof DescribeSecretCommand)
        return { ARN: keyArn, VersionIdsToStages: { [versionId]: [vault.key.versionStage] } };
      if (command instanceof GetSecretValueCommand)
        return { ARN: keyArn, VersionId: versionId, SecretString: 'fixture-private-passphrase' };
      return {};
    });
    await registerRecoveryVault(target, { uri, keyArn });
    const reads = mocks.secrets.mock.calls.filter(
      ([command]) => command instanceof GetSecretValueCommand,
    );
    expect(reads[0][0].input).toEqual({ SecretId: keyArn, VersionId: versionId });
    expect(reads.at(-1)![0].input).toMatchObject({
      VersionId: versionId,
      VersionStage: vault.key.versionStage,
    });
  });
  it('adopts an existing matching registration without rewriting metadata or key labels', async () => {
    mocks.read.mockResolvedValue({ value: vault });
    expect(await registerRecoveryVault(target, { uri: `${uri}/`, keyArn })).toEqual(vault);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(
      mocks.secrets.mock.calls.every(([command]) => command instanceof GetSecretValueCommand),
    ).toBe(true);
  });
  it('rejects encryption drift and missing key access before changing any registration', async () => {
    mocks.read.mockResolvedValue({ value: vault });
    mocks.validate.mockResolvedValue({ s3Key: { arn: 'new-key', id: 'new' } });
    await expect(registerRecoveryVault(target, { uri, keyArn })).rejects.toThrow(
      /encryption changed/,
    );
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.secrets).not.toHaveBeenCalled();
    mocks.validate.mockResolvedValue({});
    mocks.secrets.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    await expect(registerRecoveryVault(target, { uri, keyArn })).rejects.toMatchObject({
      name: 'AccessDeniedException',
    });
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('discovers a vault without loading any source deployment or local configuration', async () => {
    mocks.read.mockResolvedValue({ value: { ...vault, secretValue: 'must-not-be-returned' } });
    expect(await readRecoveryVault(target, uri)).toEqual(vault);
    expect(mocks.secrets).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([
    { ...vault, account: '999999999999' },
    { ...vault, id: 'different' },
    { ...vault, retention: 'expire' },
    { ...vault, key: { ...vault.key, versionId: 'latest' } },
    { ...vault, key: { ...vault.key, versionStage: 'AWSCURRENT' } },
    { ...vault, uri: 's3://other-bucket/path' },
  ])('rejects incompatible or ambiguous persisted identity', (value) => {
    expect(() => parseRecoveryVault(value, target, uri)).toThrow();
  });
  it('rejects a missing or mismatched retained passphrase without exposing it', async () => {
    const parsed = parseRecoveryVault(vault, target, uri);
    mocks.secrets.mockResolvedValue({
      ARN: keyArn,
      VersionId: 'different-version',
      SecretString: 'private-incorrect-value',
    });
    await expect(recoveryPassphrase(target, parsed)).rejects.toThrow(
      'Independent recovery key version could not be resolved',
    );
  });
  it('creates an independent managed stack and registers its exact outputs', async () => {
    const stackId =
      'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawVault-primary/stack-guid';
    mocks.stack.mockResolvedValue({
      StackId: stackId,
      Outputs: [
        { OutputKey: 'VaultUri', OutputValue: uri },
        { OutputKey: 'KeyArn', OutputValue: keyArn },
      ],
    });
    expect(await createRecoveryVault(target, 'primary')).toMatchObject({
      managedStackId: stackId,
      key: vault.key,
    });
    expect(mocks.stack).toHaveBeenCalledWith(target, {
      kind: 'recovery-vault',
      stackName: 'OpenclawVault-primary',
      identity: 'primary',
      vaultName: 'primary',
    });
  });
});
