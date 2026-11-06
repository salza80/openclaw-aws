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
import { parseRestoreJob, type RestoreJob } from '../openclaw/restore-contract.js';
import { object, textField } from '../openclaw/backup-contract.js';
import type { RestoreWorkerResult } from '../openclaw/restore-worker.js';
import type { RestoreActivationResult } from '../openclaw/restore-activation.js';

export interface RestoreDelivery {
  job: RestoreJob;
  artifact: RecoveryArtifact;
  request: { key: string; versionId: string; sha256: string };
}
export interface RestoreRecord {
  schemaVersion: 1;
  operationId: string;
  phase: 'provisioning' | 'restoring' | 'ready-inactive' | 'active-held';
  name: string;
  config: OpenClawConfig;
  bootstrap: RestoreBootstrap;
  recovery: { uri: string; region: string; profile?: string; pointId: string };
  target?: { stackId: string; instanceId: string };
  delivery?: RestoreDelivery;
  permissionCleanupPending?: boolean;
  result?: RestoreWorkerResult;
  activation?: RestoreActivationResult;
}
const uuid = (value: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new Error('Invalid restore operation UUID');
  return value;
};
const versionId = (value: unknown) => {
  const version = textField(value, 1024);
  if (
    version === 'null' ||
    [...version].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Restore requires a real immutable object version');
  return version;
};
export const restoreRecordPath = (operationId: string) =>
  path.join(getConfigRoot(), 'restores', `${uuid(operationId)}.json`);

export function saveRestoreRecord(record: RestoreRecord, create = false) {
  const filename = restoreRecordPath(record.operationId);
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
export function loadRestoreRecord(operationId: string): RestoreRecord {
  const filename = restoreRecordPath(operationId);
  const info = fs.lstatSync(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid?.())) ||
    info.size > 1024 * 1024
  )
    throw new Error('Local restore journal is unsafe');
  const value = object(JSON.parse(fs.readFileSync(filename, 'utf8')));
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
    value.operationId !== uuid(operationId) ||
    bootstrap.operationId !== operationId ||
    !['provisioning', 'restoring', 'ready-inactive', 'active-held'].includes(String(value.phase)) ||
    validateProjectName(name) !== true ||
    config.stack.name !== `OpenclawStack-${name}` ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)
  )
    throw new Error('Local restore journal has inconsistent ownership or phase');
  const record: RestoreRecord = {
    schemaVersion: 1,
    operationId,
    phase: value.phase as RestoreRecord['phase'],
    bootstrap,
    name,
    config,
    recovery: {
      uri,
      region,
      pointId: uuid(textField(recovery.pointId, 36)),
      ...(recovery.profile !== undefined ? { profile: textField(recovery.profile, 128) } : {}),
    },
  };
  if (value.target !== undefined) {
    const target = object(value.target);
    const stackId = textField(target.stackId, 2048);
    const instanceId = textField(target.instanceId, 32);
    if (
      !new RegExp(
        `^arn:[a-z0-9-]+:cloudformation:${config.aws.region}:[0-9]{12}:stack/OpenclawStack-${name}/[A-Za-z0-9-]+$`,
      ).test(stackId) ||
      !/^i-[a-f0-9]{8,17}$/.test(instanceId)
    )
      throw new Error('Invalid restore target identity');
    record.target = { stackId, instanceId };
  }
  if (value.delivery !== undefined) {
    const delivery = object(value.delivery);
    const job = parseRestoreJob(delivery.job);
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
      throw new Error('Restore delivery belongs to another target or operation');
    const files = artifact.files.map((item, index) => {
      const file = object(item);
      const filename = textField(file.name, 128);
      if (
        filename !== recoveryArtifactFilenames[index] ||
        !/^[a-f0-9]{64}$/.test(String(file.sha256)) ||
        file.key !== `${job.backup.job.settings.prefix}/_tools/${artifact.digest}/${filename}`
      )
        throw new Error('Invalid pinned restore artifact');
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
        `${job.backup.job.settings.prefix}/_operations/restore/${operationId}/request.json` ||
      job.backup.job.operationId !== record.recovery.pointId ||
      job.backup.job.source.region !== region
    )
      throw new Error('Restore delivery checksum or recovery lineage changed');
    record.delivery = {
      job,
      artifact: { digest, files },
      request: {
        key: request.key as string,
        versionId: versionId(request.versionId),
        sha256: requestHash,
      },
    };
  }
  // Results are historical metadata. Expose only the allowlist, then recheck live state.
  for (const key of ['result', 'activation'] as const) {
    if (!value[key]) continue;
    const saved = object(value[key]);
    if (
      !record.target ||
      saved.schemaVersion !== 1 ||
      saved.operationId !== operationId ||
      saved.stackId !== record.target.stackId ||
      saved.instanceId !== record.target.instanceId ||
      !Number.isSafeInteger(saved.memberCount) ||
      (saved.memberCount as number) < 1 ||
      !Number.isSafeInteger(saved.heldSessionCount) ||
      (saved.heldSessionCount as number) < 0
    )
      throw new Error('Historical restore result has inconsistent ownership or counts');
    const common = {
      schemaVersion: 1 as const,
      operationId,
      stackId: record.target.stackId,
      instanceId: record.target.instanceId,
      memberCount: saved.memberCount as number,
      heldSessionCount: saved.heldSessionCount as number,
    };
    if (key === 'result') {
      if (
        saved.phase !== 'ready-inactive' ||
        !Array.isArray(saved.providerParameters) ||
        saved.providerParameters.some(
          (name) =>
            typeof name !== 'string' ||
            !new RegExp(`^/openclaw/${record.name}/providers/[a-z0-9-]+/api-key$`).test(name),
        )
      )
        throw new Error('Invalid historical inactive restore result');
      record.result = {
        ...common,
        phase: 'ready-inactive',
        providerParameters: saved.providerParameters as string[],
      };
    } else {
      if (saved.phase !== 'active-held' || saved.healthy !== true)
        throw new Error('Invalid historical activation result');
      record.activation = { ...common, phase: 'active-held', healthy: true };
    }
  }
  if (value.permissionCleanupPending !== undefined) {
    if (typeof value.permissionCleanupPending !== 'boolean')
      throw new Error('Invalid permission cleanup state');
    record.permissionCleanupPending = value.permissionCleanupPending;
  }
  return record;
}
