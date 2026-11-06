import { createHash } from 'node:crypto';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { lstat, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execa } from 'execa';
import { object } from './backup-contract.js';
import { parseRestoreJob, type RestoreJob } from './restore-contract.js';

export async function privateRestoreJson(filename: string) {
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
export async function ownedRestoreRecord(filename: string, value: object) {
  try {
    const file = await open(filename, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(path.dirname(filename), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!isDeepStrictEqual(await privateRestoreJson(filename), value))
      throw new Error('Another maintenance operation owns this restore target', { cause: error });
  }
}

/** Verify the exact fresh host before either staging or deliberate activation. */
export async function verifiedRestoreTarget(
  input: RestoreJob,
  signal?: AbortSignal,
  options: { allowActive?: boolean; kind?: 'clone' } = {},
) {
  const job = parseRestoreJob(input, options);
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
      await privateRestoreJson(path.join(root, 'restore-bootstrap.json')),
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
  if (!options.allowActive) await assertInactive();
  const credentials = fromInstanceMetadata({
    ec2MetadataV1Disabled: true,
    timeout: 3000,
    maxRetries: 2,
  });
  const sts = new STSClient({ region: job.target.region, credentials });
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
  } finally {
    sts.destroy();
  }
  return {
    job,
    operationId,
    packageJson,
    home,
    root,
    work,
    owner,
    credentials,
    request,
    assertInactive,
    digest: createHash('sha256').update(JSON.stringify(job)).digest('hex'),
  };
}
