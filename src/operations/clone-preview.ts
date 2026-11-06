import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AwsTarget } from '../aws/target.js';
import { inspectBackup } from './backup.js';
import { readRecoveryVault, recoveryPassphrase } from './vault.js';
import { runBackupHelper, runClonePreviewHelper } from '../openclaw/backup-helper.js';
import { parseVerification, object } from '../openclaw/backup-contract.js';
import { planRestoreLayout } from '../openclaw/restore-layout.js';

/** Fully verified, clean-client preview before creating any target resources.
 * The decrypted archive is temporary and removed before returning the report.
 */
export async function previewSavedClone(options: {
  recoveryTarget: AwsTarget;
  vaultUri: string;
  pointId: string;
  signal?: AbortSignal;
}) {
  const point = await inspectBackup(options.recoveryTarget, options.vaultUri, options.pointId);
  const vault = await readRecoveryVault(options.recoveryTarget, options.vaultUri);
  if (vault.id !== point.vaultId) throw new Error('Clone recovery vault identity changed');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'openclaw-clone-intake-')));
  const stagingDirectory = path.join(directory, 'staging');
  try {
    const result = object(
      await runBackupHelper({
        target: options.recoveryTarget,
        operation: {
          action: 'restore',
          namespace: point.job.namespace,
          archive: point.capture.capture.location.key,
          targetDirectory: stagingDirectory,
        },
        settings: {
          ...point.job.settings,
          credentialSource: 'default',
          readVersions: Object.fromEntries(
            Object.entries(point.capture.objects).map(([key, pin]) => [key, pin.versionId]),
          ),
        },
        passphrase: await recoveryPassphrase(options.recoveryTarget, {
          ...vault,
          key: point.job.key,
        }),
        signal: options.signal,
      }),
    );
    const verification = parseVerification(result);
    if (
      result.targetPath !== stagingDirectory ||
      verification.archiveRoot !== point.capture.verification.archiveRoot ||
      verification.createdAt !== point.capture.verification.createdAt ||
      verification.assetCount !== point.capture.verification.assetCount
    )
      throw new Error('Clone native extraction differs from the completed recovery point');
    const moves = planRestoreLayout({
      manifest: JSON.parse(
        await readFile(
          path.join(stagingDirectory, verification.archiveRoot, 'manifest.json'),
          'utf8',
        ),
      ),
      capture: point.capture,
      stagingDirectory,
    });
    const preview = await runClonePreviewHelper({
      request: {
        schemaVersion: 1,
        configurationPath: point.capture.credentials.configurationPath,
        members: point.capture.members,
        moves,
        stagingDirectory,
      },
      signal: options.signal,
    });
    return { point, preview };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
