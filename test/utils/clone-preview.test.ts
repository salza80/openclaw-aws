import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { backupCapture, backupReceipt, backupVault, backupId } from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  vault: vi.fn(),
  key: vi.fn(),
  restore: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../../src/operations/backup.js', () => ({ inspectBackup: mocks.inspect }));
vi.mock('../../src/operations/vault.js', () => ({
  readRecoveryVault: mocks.vault,
  recoveryPassphrase: mocks.key,
}));
vi.mock('../../src/openclaw/backup-helper.js', () => ({
  runBackupHelper: mocks.restore,
  runClonePreviewHelper: mocks.preview,
}));
import { previewSavedClone } from '../../src/operations/clone-preview.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue(structuredClone(backupReceipt));
  mocks.vault.mockResolvedValue(structuredClone(backupVault));
  mocks.key.mockResolvedValue('private-test-recovery-passphrase');
  mocks.restore.mockImplementation(
    async ({ operation }: { operation: { targetDirectory: string } }) => {
      const root = path.join(operation.targetDirectory, 'archive');
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          archiveRoot: 'archive',
          assets: backupCapture.capture.assets.map((asset) => ({
            ...asset,
            archivePath: `archive/payload/posix${asset.sourcePath}`,
          })),
        }),
      );
      return { ...backupCapture.verification, targetPath: operation.targetDirectory };
    },
  );
  mocks.preview.mockResolvedValue({
    schemaVersion: 1,
    scope: 'whole-team-knowledge',
    content: { digest: 'a'.repeat(64) },
    policyDigest: 'b'.repeat(64),
  });
});
const options = () => ({
  recoveryTarget: testTarget,
  vaultUri: backupVault.uri,
  pointId: backupId,
});
describe('clean-client saved clone preview', () => {
  it('pins archive versions and recovery key, uses only native-verified mappings and removes decrypted staging before returning', async () => {
    mocks.vault.mockResolvedValue({
      ...backupVault,
      key: { ...backupVault.key, versionId: 'newer-vault-key' },
    });
    const result = await previewSavedClone(options());
    expect(result.point.id).toBe(backupId);
    expect(result.preview.scope).toBe('whole-team-knowledge');
    expect(mocks.key.mock.calls[0][1].key).toEqual(backupReceipt.job.key);
    const extraction = mocks.restore.mock.calls[0][0];
    expect(extraction.settings.readVersions).toEqual({
      'openclaw-storage.json': 'marker-version',
      'backups/installation/20261106T000000Z-12345678.tar.gz': 'archive-version',
    });
    expect(extraction.settings.credentialSource).toBe('default');
    expect(mocks.preview.mock.calls[0][0].request.moves).toEqual(
      backupCapture.capture.assets.map((asset) => ({
        source: `${extraction.operation.targetDirectory}/archive/payload/posix${asset.sourcePath}`,
        destination: asset.sourcePath,
      })),
    );
    await expect(lstat(path.dirname(extraction.operation.targetDirectory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('refuses changed native verification before inspecting configuration and still removes decrypted data', async () => {
    mocks.restore.mockImplementation(
      async ({ operation }: { operation: { targetDirectory: string } }) => {
        await mkdir(operation.targetDirectory, { recursive: true });
        return {
          ...backupCapture.verification,
          assetCount: 3,
          targetPath: operation.targetDirectory,
        };
      },
    );
    await expect(previewSavedClone(options())).rejects.toThrow('differs');
    expect(mocks.preview).not.toHaveBeenCalled();
    await expect(
      lstat(path.dirname(mocks.restore.mock.calls[0][0].operation.targetDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes decrypted data when source policy is unsupported and never returns a partial preview', async () => {
    mocks.preview.mockRejectedValue(new Error('unsupported native runtime mapping'));
    await expect(previewSavedClone(options())).rejects.toThrow('unsupported');
    await expect(
      lstat(path.dirname(mocks.restore.mock.calls[0][0].operation.targetDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
