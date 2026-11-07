import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RestoreJob } from './restore-contract.js';
import { stageRecoveryArchive } from './recovery-staging.js';
import { installRestoreLayout } from './restore-layout.js';
import { reconcileNativeRestore } from './restore-reconciliation.js';
import { verifiedRestoreTarget, ownedRestoreRecord as ownedRecord } from './restore-control.js';
import { publishTeamMembership } from './team-recovery.js';

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
    const { moves } = await stageRecoveryArchive({ job, work, digest, secrets, request, signal });
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
      deploymentRegion: job.target.region,
      ...(job.bedrock ? { bedrock: job.bedrock } : {}),
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
    if (job.backup.capture.credentials.team)
      await publishTeamMembership('/home/ubuntu', job.target, job.backup.capture.credentials.team);
    await ownedRecord(path.join(work, 'ready.json'), result);
    return result;
  } finally {
    secrets.destroy();
    ssm.destroy();
  }
}
