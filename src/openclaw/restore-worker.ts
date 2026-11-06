import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RestoreJob } from './restore-contract.js';
import { stageNativeRestore } from './native-restore-host.js';
import { installRestoreLayout, type RestoreAssetMove } from './restore-layout.js';
import { reconcileNativeRestore } from './restore-reconciliation.js';
import {
  verifiedRestoreTarget,
  privateRestoreJson as privateJson,
  ownedRestoreRecord as ownedRecord,
} from './restore-control.js';

export interface RestoreWorkerResult {
  schemaVersion: 1;
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: 'ready-inactive';
  memberCount: number;
  heldSessionCount: number;
  providerParameters: string[];
}
/** The entry point holds flock. No code in this worker is executed as root. */
export async function runRestoreWorker(
  input: RestoreJob,
  signal?: AbortSignal,
): Promise<RestoreWorkerResult> {
  const { job, operationId, root, work, owner, credentials, request, assertInactive, digest } =
    await verifiedRestoreTarget(input, signal);
  const secrets = new SecretsManagerClient({ region: job.backup.job.source.region, credentials });
  const ssm = new SSMClient({ region: job.target.region, credentials });
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    await ownedRecord(path.join(root, 'maintenance.json'), {
      schemaVersion: 1,
      kind: 'restore',
      operationId,
      stackId: job.target.stackId,
      roleId: job.target.roleId,
      digest,
    });
    await ownedRecord(path.join(work, 'restore-owner.json'), { schemaVersion: 1, owner, digest });
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
        await lstat(path.join(work, 'layout.json'));
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
      if (
        material.ARN !== key.arn ||
        material.VersionId !== key.versionId ||
        !material.SecretString
      )
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
    await assertInactive();
    await installRestoreLayout({ operationId, moves, journal: path.join(work, 'layout.json') });
    const tokenName = `/openclaw/${job.target.deploymentName}/gateway-token`;
    const token = await ssm.send(
      new GetParameterCommand({ Name: tokenName, WithDecryption: true }),
      request(),
    );
    if (
      token.Parameter?.Name !== tokenName ||
      token.Parameter.Type !== 'SecureString' ||
      !token.Parameter.Value
    )
      throw new Error('Fresh target Gateway credential is unavailable');
    const reconciled = await reconcileNativeRestore({
      job: job.backup.job,
      capture: job.backup.capture,
      owner,
      gatewayToken: token.Parameter.Value,
      pluginDirectory: job.pluginDirectory,
      ssm,
      assertInactive,
      signal,
    });
    const result: RestoreWorkerResult = {
      schemaVersion: 1,
      operationId,
      stackId: job.target.stackId,
      instanceId: job.target.instanceId,
      phase: 'ready-inactive',
      memberCount: reconciled.members.length,
      heldSessionCount: reconciled.sessionHold.held,
      providerParameters: reconciled.imported.parameterNames,
    };
    await ownedRecord(path.join(work, 'ready.json'), result);
    return result;
  } finally {
    secrets.destroy();
    ssm.destroy();
  }
}
