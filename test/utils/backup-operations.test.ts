import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';
import {
  backupCapture,
  backupId,
  backupJob,
  backupReceipt,
  backupSource,
  backupVault,
} from '../helpers/fixtures/backup.js';
const mocks = vi.hoisted(() => ({
  readVault: vi.fn(),
  security: vi.fn(),
  passphrase: vi.fn(),
  source: vi.fn(),
  remote: vi.fn(),
  access: vi.fn(),
  artifact: vi.fn(),
  helper: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  put: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../../src/operations/vault.js', () => ({
  readRecoveryVault: mocks.readVault,
  recoveryPassphrase: mocks.passphrase,
}));
vi.mock('../../src/aws/vault-security.js', () => ({ validateVaultSecurity: mocks.security }));
vi.mock('../../src/aws/recovery-source.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/recovery-source.js')>()),
  inspectRecoverySource: mocks.source,
}));
vi.mock('../../src/aws/recovery-store.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/recovery-store.js')>()),
  recoveryStore: () => ({ read: mocks.read, putImmutable: mocks.put, close: mocks.close }),
}));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: mocks.remote }));
vi.mock('../../src/aws/auxiliary-stacks.js', () => ({ ensureRecoveryStack: mocks.access }));
vi.mock('../../src/aws/recovery-artifact.js', () => ({ uploadRecoveryArtifact: mocks.artifact }));
vi.mock('../../src/openclaw/backup-helper.js', () => ({ runBackupHelper: mocks.helper }));
vi.mock('../../src/operations/lock.js', () => ({
  withDeploymentLock: async (_ctx: unknown, operation: () => Promise<unknown>) => operation(),
}));
vi.mock('@aws-sdk/client-s3', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send = mocks.list;
    destroy() {}
  },
}));
import {
  assertIndependentVault,
  createBackup,
  inspectBackup,
  listBackups,
  verifyBackup,
} from '../../src/operations/backup.js';
const target = { ...testTarget, region: 'eu-central-1' };
const ctx = makeCommandContext({ target });
const captureName = `native/${backupJob.settings.prefix.split('/').at(-1)}/_operations/${backupId}/capture.json`;
let metadata: Map<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  metadata = new Map();
  mocks.readVault.mockResolvedValue(structuredClone(backupVault));
  mocks.security.mockResolvedValue({});
  mocks.passphrase.mockResolvedValue('private-vault-passphrase');
  mocks.source.mockResolvedValue(structuredClone(backupSource));
  mocks.artifact.mockResolvedValue({
    digest: 'b'.repeat(64),
    files: [
      {
        name: 'worker.js',
        key: 'artifact-key',
        versionId: 'artifact-version',
        sha256: 'c'.repeat(64),
      },
    ],
  });
  mocks.access.mockResolvedValue({});
  mocks.read.mockImplementation(async (name) =>
    metadata.has(name)
      ? { value: metadata.get(name), versionId: 'metadata-version', checksumSHA256: 'checksum' }
      : undefined,
  );
  mocks.put.mockImplementation(async (name, value) => {
    metadata.set(name, structuredClone(value));
    return {
      value,
      versionId: 'request-version',
      checksumSHA256: createHash('sha256').update(JSON.stringify(value)).digest('base64'),
    };
  });
  mocks.remote.mockImplementation(async (_id, _target, commands) => {
    if (commands[0].includes('openclaw --version'))
      return { stdout: '24.22.2\nOpenClaw 2026.11.1 (4ffdd20)' };
    metadata.set(captureName, structuredClone(backupCapture));
    return {
      stdout: JSON.stringify({
        ok: true,
        operationId: backupId,
        key: `_operations/${backupId}/capture.json`,
        versionId: 'capture-version',
      }),
    };
  });
  mocks.helper.mockResolvedValue(structuredClone(backupCapture.verification));
  mocks.list.mockResolvedValue({ Contents: [{ Key: `vault/main/receipts/${backupId}.json` }] });
});
const create = () =>
  createBackup(ctx, { vaultUri: backupVault.uri, operationId: backupId, label: 'checkpoint' });
describe('portable backup operations', () => {
  it('refuses a replaced UI approval before native reads, source grants or request uploads', async () => {
    await expect(
      createBackup(ctx, {
        vaultUri: backupVault.uri,
        operationId: backupId,
        expectedSource: {
          stackId: backupSource.stackId,
          instanceId: 'i-aaaaaaaaaaaaaaaaa',
          roleId: backupSource.role.id,
        },
      }),
    ).rejects.toThrow('replaced');
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('commits a receipt after host verification, with scoped permissions and no secret transport', async () => {
    const result = await create();
    expect(result.capture.verification.ok).toBe(true);
    expect(mocks.access).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        access: expect.objectContaining({
          roleName: backupSource.role.name,
          dataPrefix: backupJob.settings.prefix,
          keyArn: backupVault.key.arn,
        }),
      }),
    );
    expect(mocks.put.mock.calls.at(-1)?.[0]).toBe(`receipts/${backupId}.json`);
    const script = mocks.remote.mock.calls[1][2][0];
    expect(script).toContain('--version-id');
    expect(script).toContain('sha256sum --check');
    expect(script).toContain('env -i');
    expect(script).not.toContain('private-vault-passphrase');
    expect(JSON.stringify(result)).not.toContain('private-vault-passphrase');
    expect(result.source.resources).toEqual([]);
  });
  it('refuses incompatible installations before IAM or object writes', async () => {
    mocks.remote.mockResolvedValueOnce({ stdout: '22.0.0\nOpenClaw 2026.10.9' });
    await expect(create()).rejects.toThrow('not implicitly upgraded');
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.artifact).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('refuses encryption drift and source-owned recovery storage', async () => {
    mocks.security.mockResolvedValueOnce({ s3Key: { arn: 'changed', id: 'changed' } });
    await expect(create()).rejects.toThrow('encryption changed');
    mocks.source.mockResolvedValueOnce({
      ...backupSource,
      resources: [{ type: 'AWS::S3::Bucket', id: 'private-backups' }],
    });
    await expect(create()).rejects.toThrow('independently');
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it('refuses source-owned KMS keys and vault stacks', () => {
    expect(() =>
      assertIndependentVault(
        { ...backupSource, resources: [{ type: 'AWS::KMS::Key', id: 'key-id' }] },
        {
          ...backupVault,
          encryption: {
            s3Key: { id: 'key-id', arn: 'arn:aws:kms:eu-central-1:123456789012:key/key-id' },
          },
        },
      ),
    ).toThrow('independently');
    expect(() =>
      assertIndependentVault(backupSource, {
        ...backupVault,
        managedStackId: backupSource.stackId,
      }),
    ).toThrow('independently');
  });
  it('does not commit after uncertain SSM execution', async () => {
    mocks.remote
      .mockImplementationOnce(async () => ({ stdout: '24.22.2\nOpenClaw 2026.11.1 (4ffdd20)' }))
      .mockRejectedValueOnce(Error('SSM timeout'));
    await expect(create()).rejects.toThrow('SSM timeout');
    expect(metadata.has(`receipts/${backupId}.json`)).toBe(false);
  });
  it('adopts a verified remote capture on retry without stopping the source again', async () => {
    metadata.set(captureName, structuredClone(backupCapture));
    await create();
    expect(mocks.remote).toHaveBeenCalledTimes(1);
    expect(metadata.has(`receipts/${backupId}.json`)).toBe(true);
  });
  it('adopts a completed point without new host, IAM or upload operations', async () => {
    metadata.set(`receipts/${backupId}.json`, structuredClone(backupReceipt));
    await create();
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('rejects capture metadata for another operation, unverified data or missing object pins', async () => {
    for (const changed of [
      { operationId: '22222222-2222-2222-2222-222222222222' },
      { verification: { ...backupCapture.verification, ok: false } },
      { objects: {} },
    ]) {
      metadata.set(captureName, { ...structuredClone(backupCapture), ...changed });
      await expect(create()).rejects.toThrow();
      expect(metadata.has(`receipts/${backupId}.json`)).toBe(false);
    }
  });
  it('reads a point without source configuration and removes unknown raw fields', async () => {
    metadata.set(`receipts/${backupId}.json`, {
      ...backupReceipt,
      privateDebug: 'must-not-escape',
    });
    const point = await inspectBackup(target, backupVault.uri, backupId);
    expect(JSON.stringify(point)).not.toContain('must-not-escape');
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it('verifies exact versions using operator credentials in a clean native helper', async () => {
    metadata.set(`receipts/${backupId}.json`, backupReceipt);
    await expect(verifyBackup(target, backupVault.uri, backupId)).resolves.toMatchObject({
      verified: true,
    });
    expect(mocks.helper).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          credentialSource: 'default',
          readVersions: {
            'openclaw-storage.json': 'marker-version',
            'backups/installation/20261106T000000Z-12345678.tar.gz': 'archive-version',
          },
        }),
      }),
    );
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it('can rescue a pinned point when current vault write-security settings have changed', async () => {
    metadata.set(`receipts/${backupId}.json`, backupReceipt);
    mocks.security.mockRejectedValueOnce(
      new Error('Current vault settings no longer permit new backups'),
    );
    await expect(verifyBackup(target, backupVault.uri, backupId)).resolves.toMatchObject({
      verified: true,
    });
    expect(mocks.security).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('uses the native catalog to confirm completed archive discovery', async () => {
    metadata.set(`receipts/${backupId}.json`, backupReceipt);
    mocks.helper.mockResolvedValueOnce({ backups: [{ key: backupCapture.capture.location.key }] });
    await expect(listBackups(target, backupVault.uri)).resolves.toHaveLength(1);
    expect(mocks.readVault).toHaveBeenCalledTimes(1);
    mocks.helper.mockResolvedValueOnce({ backups: [] });
    await expect(listBackups(target, backupVault.uri)).rejects.toThrow('native catalog');
  });
});
