import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { OpenClawConfig } from '../cli/types/index.js';
import { getConfigRoot } from '../cli/utils/config.js';
import { validateConfig } from '../cli/utils/config-validation.js';
import { validateProjectName } from '../cli/utils/validation.js';
import { parseRestoreBootstrap, type RestoreBootstrap } from '../aws/restore-bootstrap.js';
import { recoveryArtifactFilenames, type RecoveryArtifact } from '../aws/recovery-artifact.js';
import { parseVaultUri } from '../aws/recovery-store.js';
import type { RestoreJob } from '../openclaw/restore-contract.js';
import { object, textField } from '../openclaw/backup-contract.js';
export interface RecoveryDelivery<T extends RestoreJob = RestoreJob> {
  job: T;
  artifact: RecoveryArtifact;
  request: { key: string; versionId: string; sha256: string };
}
export interface RecoveryRecordBase<T extends string = string> {
  schemaVersion: 1;
  operationId: string;
  phase: T;
  name: string;
  config: OpenClawConfig;
  bootstrap: RestoreBootstrap;
  recovery: { uri: string; region: string; profile?: string; pointId: string };
  target?: { stackId: string; instanceId: string };
  account?: string;
  partition?: string;
  permissionCleanupPending?: boolean;
}
export function recoveryUuid(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new Error('Invalid recovery operation UUID');
  return value;
}
function versionId(value: unknown) {
  const version = textField(value, 1024);
  if (
    version === 'null' ||
    [...version].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('Recovery requires a real immutable object version');
  return version;
}
export const recoveryRecordPath = (kind: 'restores' | 'clones', operationId: string) =>
  path.join(getConfigRoot(), kind, `${recoveryUuid(operationId)}.json`);
export function saveRecoveryRecord(
  kind: 'restores' | 'clones',
  record: RecoveryRecordBase,
  create = false,
) {
  const filename = recoveryRecordPath(kind, record.operationId);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(record, null, 2);
  if (create) fs.writeFileSync(filename, body, { flag: 'wx', mode: 0o600 });
  else {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
export function readRecoveryRecord(kind: 'restores' | 'clones', operationId: string) {
  const filename = recoveryRecordPath(kind, operationId);
  const info = fs.lstatSync(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid?.())) ||
    info.size > 1024 * 1024
  )
    throw new Error('Local recovery journal is unsafe');
  return object(JSON.parse(fs.readFileSync(filename, 'utf8')));
}
export function parseRecoveryRecordBase<T extends string>(
  value: Record<string, unknown>,
  operationId: string,
  phases: readonly T[],
): RecoveryRecordBase<T> {
  const bootstrap = parseRestoreBootstrap(value.bootstrap);
  const name = textField(value.name, 50);
  const config = value.config as OpenClawConfig;
  validateConfig(config);
  const recovery = object(value.recovery);
  const uri = textField(recovery.uri);
  parseVaultUri(uri);
  const region = textField(recovery.region, 64);
  if (
    value.schemaVersion !== 1 ||
    value.operationId !== recoveryUuid(operationId) ||
    bootstrap.operationId !== operationId ||
    !phases.includes(value.phase as T) ||
    validateProjectName(name) !== true ||
    config.stack.name !== `OpenclawStack-${name}` ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)
  )
    throw new Error('Local recovery journal has inconsistent ownership or phase');
  const record: RecoveryRecordBase<T> = {
    schemaVersion: 1,
    operationId,
    phase: value.phase as T,
    bootstrap,
    name,
    config,
    recovery: {
      uri,
      region,
      pointId: recoveryUuid(textField(recovery.pointId, 36)),
      ...(recovery.profile !== undefined ? { profile: textField(recovery.profile, 128) } : {}),
    },
  };
  if (value.account !== undefined || value.partition !== undefined) {
    const account = textField(value.account, 12),
      partition = textField(value.partition, 32);
    if (!/^\d{12}$/.test(account) || !/^[a-z0-9-]+$/.test(partition))
      throw new Error('Invalid recovery target account/partition');
    record.account = account;
    record.partition = partition;
  }
  if (value.target !== undefined) {
    const target = object(value.target);
    const stackId = textField(target.stackId, 2048);
    const instanceId = textField(target.instanceId, 32);
    if (
      !new RegExp(
        `^arn:[a-z0-9-]+:cloudformation:${config.aws.region}:[0-9]{12}:stack/OpenclawStack-${name}/[A-Za-z0-9-]+$`,
      ).test(stackId) ||
      !/^i-[a-f0-9]{8,17}$/.test(instanceId) ||
      (record.account !== undefined && stackId.split(':')[4] !== record.account) ||
      (record.partition !== undefined && stackId.split(':')[1] !== record.partition)
    )
      throw new Error('Invalid recovery target identity');
    record.target = { stackId, instanceId };
  }
  if (value.permissionCleanupPending !== undefined) {
    if (typeof value.permissionCleanupPending !== 'boolean')
      throw new Error('Invalid permission cleanup state');
    record.permissionCleanupPending = value.permissionCleanupPending;
  }
  return record;
}
export function parseRecoveryDelivery<T extends RestoreJob>(
  value: unknown,
  record: RecoveryRecordBase,
  kind: 'restore' | 'clone',
  parseJob: (value: unknown) => T,
): RecoveryDelivery<T> {
  const {
    bootstrap,
    name,
    recovery: { region },
    operationId,
  } = record;
  const delivery = object(value);
  const job = parseJob(delivery.job);
  const artifact = object(delivery.artifact);
  const request = object(delivery.request);
  if (
    !record.target ||
    job.target.stackId !== record.target.stackId ||
    job.target.instanceId !== record.target.instanceId ||
    job.target.deploymentName !== name ||
    !isDeepStrictEqual(job.bootstrap, bootstrap) ||
    !/^[a-f0-9]{64}$/.test(String(artifact.digest)) ||
    !Array.isArray(artifact.files) ||
    artifact.files.length !== recoveryArtifactFilenames.length
  )
    throw new Error('Recovery delivery belongs to another target or operation');
  const files = artifact.files.map((item, index) => {
    const file = object(item);
    const filename = textField(file.name, 128);
    if (
      filename !== recoveryArtifactFilenames[index] ||
      !/^[a-f0-9]{64}$/.test(String(file.sha256)) ||
      file.key !== `${job.backup.job.settings.prefix}/_tools/${artifact.digest}/${filename}`
    )
      throw new Error('Invalid pinned recovery artifact');
    return {
      name: filename,
      key: file.key as string,
      versionId: versionId(file.versionId),
      sha256: file.sha256 as string,
    };
  });
  const digest = createHash('sha256')
    .update(JSON.stringify(files.map(({ name, sha256 }) => [name, sha256])))
    .digest('hex');
  const requestHash = createHash('sha256').update(JSON.stringify(job)).digest('hex');
  if (
    digest !== artifact.digest ||
    job.pluginDirectory !== `/home/ubuntu/.openclaw-aws/plugins/${digest}` ||
    request.sha256 !== requestHash ||
    request.key !==
      `${job.backup.job.settings.prefix}/_operations/${kind}/${operationId}/request.json` ||
    job.backup.job.operationId !== record.recovery.pointId ||
    job.backup.job.source.region !== region
  )
    throw new Error('Recovery delivery checksum or recovery lineage changed');
  return {
    job,
    artifact: { digest, files },
    request: {
      key: request.key as string,
      versionId: versionId(request.versionId),
      sha256: requestHash,
    },
  };
}
