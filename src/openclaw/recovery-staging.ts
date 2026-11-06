import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RestoreJob } from './restore-contract.js';
import type { RestoreAssetMove } from './restore-layout.js';
import { stageNativeRestore } from './native-restore-host.js';
import {
  privateRestoreJson as privateJson,
  ownedRestoreRecord as ownedRecord,
} from './restore-control.js';

/** Shared exact-version extraction. No source identity is adopted by this step. */
export async function stageRecoveryArchive(options: {
  job: RestoreJob;
  work: string;
  digest: string;
  secrets: Pick<SecretsManagerClient, 'send'>;
  request: () => { abortSignal: AbortSignal };
  adoptionJournal?: string;
  signal?: AbortSignal;
}) {
  const { job, work, digest, secrets, request, signal } = options;
  const stagedRecord = path.join(work, 'staged.json');
  const stagingDirectory = path.join(work, 'staging');
  let moves: RestoreAssetMove[] | undefined;
  try {
    const prior = await privateJson(stagedRecord);
    if (prior.digest !== digest || !Array.isArray(prior.moves))
      throw new Error('Staged restore belongs to another request');
    moves = prior.moves as RestoreAssetMove[];
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (!moves) {
    // This private staging tree belongs to this exact immutable request. No
    // layout moves exist yet, so interrupted extraction can be recreated.
    try {
      await lstat(path.join(work, options.adoptionJournal ?? 'layout.json'));
      throw new Error('Restore layout exists without its staging receipt');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    const key = job.backup.job.key;
    const material = await secrets.send(
      new GetSecretValueCommand({
        SecretId: key.arn,
        VersionId: key.versionId,
        VersionStage: key.versionStage,
      }),
      request(),
    );
    if (material.ARN !== key.arn || material.VersionId !== key.versionId || !material.SecretString)
      throw new Error('Independent recovery key version is unavailable');
    const staged = await stageNativeRestore({
      job: job.backup.job,
      capture: job.backup.capture,
      passphrase: material.SecretString,
      pluginDirectory: job.pluginDirectory,
      stagingDirectory,
      signal,
    });
    moves = staged.moves;
    await ownedRecord(stagedRecord, { schemaVersion: 1, digest, moves });
  }

  return { moves, stagingDirectory };
}
