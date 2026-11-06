import { createHash } from 'node:crypto';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execa } from 'execa';
import { object } from './backup-contract.js';
import { parseRestoreJob, type RestoreJob } from './restore-contract.js';
import { stageNativeRestore } from './native-restore-host.js';
import { installRestoreLayout, type RestoreAssetMove } from './restore-layout.js';
import { reconcileNativeRestore } from './restore-reconciliation.js';

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
async function privateJson(filename: string) {
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.() ||
    stat.size > 1024 * 1024
  )
    throw new Error('Restore control file is unsafe');
  return object(JSON.parse(await readFile(filename, 'utf8')));
}
async function ownedRecord(filename: string, value: object) {
  try {
    await writeFile(filename, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!isDeepStrictEqual(await privateJson(filename), value))
      throw new Error('Another maintenance operation owns this restore target', { cause: error });
  }
}

/** The entry point holds flock. No code in this worker is executed as root. */
export async function runRestoreWorker(
  input: RestoreJob,
  signal?: AbortSignal,
): Promise<RestoreWorkerResult> {
  const job = parseRestoreJob(input);
  const operationId = job.bootstrap.operationId;
  const packageJson = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/openclaw/package.json',
  );
  if (
    process.version !== `v${job.bootstrap.runtime.node}` ||
    JSON.parse(await readFile(packageJson, 'utf8')).version !== job.bootstrap.runtime.openclaw
  )
    throw new Error('Restore worker runtime differs from the recorded supported pins');
  const home = homedir();
  if (home !== '/home/ubuntu') throw new Error('Restore worker requires the supported Ubuntu home');
  const root = path.join(home, '.openclaw-aws');
  const work = path.join(root, 'jobs', operationId);
  const owner = {
    deploymentName: job.target.deploymentName,
    deploymentId: job.target.stackId,
    operationId,
  };
  const expectedBootstrap = {
    schemaVersion: 1,
    operationId,
    stackId: job.target.stackId,
    openclaw: job.bootstrap.runtime.openclaw,
    node: job.bootstrap.runtime.node,
    gateway: 'masked',
  };
  if (
    !isDeepStrictEqual(
      await privateJson(path.join(root, 'restore-bootstrap.json')),
      expectedBootstrap,
    )
  )
    throw new Error('Restore bootstrap identity differs from this target and operation');
  const assertInactive = async () => {
    const result = await execa(
      'systemctl',
      [
        '--user',
        'show',
        'openclaw-gateway.service',
        '--property=ActiveState',
        '--property=LoadState',
        '--value',
      ],
      { timeout: 15000 },
    );
    const states = result.stdout.split('\n');
    if (
      !states.includes('masked') ||
      !states.some((value) => ['inactive', 'failed'].includes(value))
    )
      throw new Error('Restore target Gateway is not persistently masked and inactive');
  };
  await assertInactive();
  const credentials = fromInstanceMetadata({
    ec2MetadataV1Disabled: true,
    timeout: 3000,
    maxRetries: 2,
  });
  const sts = new STSClient({ region: job.target.region, credentials });
  const secrets = new SecretsManagerClient({ region: job.backup.job.source.region, credentials });
  const ssm = new SSMClient({ region: job.target.region, credentials });
  const request = () => ({
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}), request());
    if (
      identity.Account !== job.target.account ||
      identity.UserId !== `${job.target.roleId}:${job.target.instanceId}` ||
      !identity.Arn?.endsWith(`/${job.target.instanceId}`)
    )
      throw new Error('Restore worker is not using the expected target instance role');
    await mkdir(work, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(JSON.stringify(job)).digest('hex');
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
    sts.destroy();
    secrets.destroy();
    ssm.destroy();
  }
}
