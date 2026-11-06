import { createHash } from 'node:crypto';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { nativeBackupHost, type NativeBackupHost } from './native-backup-host.js';
import {
  nativeArchiveCaptureControl,
  type ArchiveCaptureControl,
} from './archive-capture-control.js';
import {
  assertMemberCoverage,
  assertArchiveRoster,
  backupJobDigest,
  object,
  parseBackupJob,
  parseCapturedBackup,
  type BackupCaptureJob,
  type CapturedBackup,
  type NativeCaptureSummary,
} from './backup-contract.js';

type ObjectPin = { versionId: string; storedBytes: number };
export interface CaptureStorage {
  identify(): Promise<void>;
  passphrase(): Promise<string>;
  marker(locationId: string): Promise<ObjectPin>;
  archive(capture: NativeCaptureSummary): Promise<ObjectPin>;
  publish(result: CapturedBackup): Promise<{ key: string; versionId: string }>;
  close(): void;
}
export interface MaintenanceRecord {
  schemaVersion: 1;
  operationId: string;
  stackId: string;
  roleId: string;
  initial: 'active' | 'inactive' | 'failed';
}
export interface CaptureMaintenance {
  enter(initial: MaintenanceRecord): Promise<MaintenanceRecord>;
  release(): Promise<void>;
}
export function hostCaptureMaintenance(
  job: BackupCaptureJob,
): CaptureMaintenance & { inspect(): Promise<MaintenanceRecord | undefined> } {
  const directory = path.join(homedir(), '.openclaw-aws');
  const filename = path.join(directory, 'maintenance.json');
  return {
    async inspect() {
      let current;
      try {
        current = object(JSON.parse(await readFile(filename, 'utf8')));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
      if (
        current.schemaVersion !== 1 ||
        current.operationId !== job.operationId ||
        current.stackId !== job.source.stackId ||
        current.roleId !== job.source.roleId ||
        !['active', 'inactive', 'failed'].includes(String(current.initial))
      )
        throw new Error('Another maintenance operation owns this host');
      return current as unknown as MaintenanceRecord;
    },
    async enter(initial) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(filename, JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
        return initial;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
          throw error;
        const previous = object(JSON.parse(await readFile(filename, 'utf8')));
        if (
          previous.schemaVersion !== 1 ||
          previous.operationId !== job.operationId ||
          previous.stackId !== job.source.stackId ||
          previous.roleId !== job.source.roleId ||
          !['active', 'inactive', 'failed'].includes(String(previous.initial))
        )
          throw new Error(
            'Another maintenance operation owns this host; inspect it instead of clearing a lock by age',
            { cause: error },
          );
        return previous as unknown as MaintenanceRecord;
      }
    },
    async release() {
      const current = object(JSON.parse(await readFile(filename, 'utf8')));
      if (
        current.operationId !== job.operationId ||
        current.stackId !== job.source.stackId ||
        current.roleId !== job.source.roleId
      )
        throw new Error('Host maintenance ownership changed');
      await rm(filename);
    },
  };
}
function actualVersion(value: string | undefined): string {
  if (!value || value === 'null')
    throw new Error('Backup storage did not return an immutable S3 version');
  return value;
}
export function roleCaptureStorage(job: BackupCaptureJob, signal?: AbortSignal): CaptureStorage {
  const requestSignal = () =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const credentials = fromInstanceMetadata({
    ec2MetadataV1Disabled: true,
    timeout: 3000,
    maxRetries: 2,
  });
  const config = { region: job.source.region, credentials };
  const s3 = new S3Client(config);
  const secrets = new SecretsManagerClient(config);
  const sts = new STSClient(config);
  const common = { Bucket: job.settings.bucket, ExpectedBucketOwner: job.source.account };
  const key = (relative: string) => `${job.settings.prefix}/${relative}`;
  return {
    async identify() {
      const identity = await sts.send(new GetCallerIdentityCommand({}), {
        abortSignal: requestSignal(),
      });
      if (
        identity.Account !== job.source.account ||
        identity.UserId !== `${job.source.roleId}:${job.source.instanceId}` ||
        !identity.Arn?.endsWith(`/${job.source.instanceId}`)
      )
        throw new Error('Backup worker is not using the expected hosting instance role');
    },
    async passphrase() {
      const result = await secrets.send(
        new GetSecretValueCommand({
          SecretId: job.key.arn,
          VersionId: job.key.versionId,
          VersionStage: job.key.versionStage,
        }),
        { abortSignal: requestSignal() },
      );
      if (
        result.ARN !== job.key.arn ||
        result.VersionId !== job.key.versionId ||
        !result.SecretString
      )
        throw new Error('Independent recovery key could not be resolved');
      return result.SecretString;
    },
    async marker(locationId) {
      const head = await s3.send(
        new HeadObjectCommand({ ...common, Key: key('openclaw-storage.json') }),
        { abortSignal: requestSignal() },
      );
      const versionId = actualVersion(head.VersionId);
      if (head.ContentLength === undefined || head.ContentLength > 4096)
        throw new Error('Native storage marker has invalid size');
      const result = await s3.send(
        new GetObjectCommand({
          ...common,
          Key: key('openclaw-storage.json'),
          VersionId: versionId,
        }),
        { abortSignal: requestSignal() },
      );
      const marker = object(JSON.parse(await result.Body!.transformToString()));
      if (marker.locationId !== locationId)
        throw new Error('Native storage identity changed before capture');
      return { versionId, storedBytes: head.ContentLength };
    },
    async archive(capture) {
      const relative = `backups/${job.namespace}/${capture.location.key}`;
      const head = await s3.send(new HeadObjectCommand({ ...common, Key: key(relative) }), {
        abortSignal: requestSignal(),
      });
      const versionId = actualVersion(head.VersionId);
      if (head.ContentLength !== capture.location.storedBytes)
        throw new Error('Remote archive size differs from native capture');
      const tags = await s3.send(
        new GetObjectTaggingCommand({ ...common, Key: key(relative), VersionId: versionId }),
        { abortSignal: requestSignal() },
      );
      if (
        !tags.TagSet?.some(
          (tag) => tag.Key === 'openclaw-aws-operation' && tag.Value === job.operationId,
        )
      )
        throw new Error('Remote archive belongs to another capture operation');
      return { versionId, storedBytes: head.ContentLength };
    },
    async publish(result) {
      const body = Buffer.from(JSON.stringify(result));
      if (body.length > 128 * 1024)
        throw new Error('Capture metadata exceeds the supported receipt size');
      const relative = `_operations/${job.operationId}/capture.json`;
      let versionId: string | undefined;
      try {
        const published = await s3.send(
          new PutObjectCommand({
            ...common,
            Key: key(relative),
            Body: body,
            ContentLength: body.length,
            ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
            IfNoneMatch: '*',
            ContentType: 'application/json',
          }),
          { abortSignal: requestSignal() },
        );
        versionId = actualVersion(published.VersionId);
      } catch (error) {
        if (
          !result.gateway.held ||
          !(error instanceof Error) ||
          error.name !== 'PreconditionFailed'
        )
          throw error;
        const existing = await s3.send(new GetObjectCommand({ ...common, Key: key(relative) }), {
          abortSignal: requestSignal(),
        });
        try {
          if (
            existing.ContentLength !== body.length ||
            !Buffer.from(await existing.Body!.transformToByteArray()).equals(body)
          )
            throw new Error(
              'Existing archive capture receipt differs from this verified operation',
              { cause: error },
            );
          versionId = actualVersion(existing.VersionId);
        } finally {
          if (
            existing.Body &&
            'destroy' in existing.Body &&
            typeof existing.Body.destroy === 'function'
          )
            existing.Body.destroy();
        }
      }
      return { key: relative, versionId };
    },
    close() {
      s3.destroy();
      secrets.destroy();
      sts.destroy();
    },
  };
}

/** A native recovery point can be published only after complete remote verification. */
export async function captureInstallation(
  job: BackupCaptureJob,
  host: NativeBackupHost,
  storage: CaptureStorage,
  maintenance: CaptureMaintenance,
  archive?: ArchiveCaptureControl,
) {
  let ownership: MaintenanceRecord | undefined;
  let restored = false;
  let captured: CapturedBackup | undefined;
  let failure: unknown;
  let archiveStartedHere = false;
  try {
    if (job.archive && !archive)
      throw new Error('Archive capture requires its durable native service controller');
    await storage.identify();
    const initial = await host.gateway.inspect();
    ownership = await maintenance.enter({
      schemaVersion: 1,
      operationId: job.operationId,
      stackId: job.source.stackId,
      roleId: job.source.roleId,
      initial,
    });
    if (job.archive) {
      captured = await archive!.resume();
      if (!captured) {
        archiveStartedHere = true;
        await archive!.begin(ownership.initial);
      }
    } else if (initial === 'active') await host.gateway.stop();
    if (!captured) {
      const approvedMembers = job.archive ? await host.members() : undefined;
      if (job.archive) {
        assertArchiveRoster(job.archive.expectedMembers, approvedMembers!);
        await archive!.assertHeld();
      }
      const { locationId } = await host.prepareStorage(await storage.passphrase());
      const marker = await storage.marker(locationId);
      const members = approvedMembers ?? (await host.members());
      const capture = await host.capture();
      if (
        capture.location.namespace !== job.namespace ||
        capture.location.locationId !== locationId
      )
        throw new Error('Native capture storage identity differs from the planned location');
      assertMemberCoverage(capture, members);
      const credentials = await host.credentials(capture, members);
      const storedArchive = await storage.archive(capture);
      const archivePath = `backups/${job.namespace}/${capture.location.key}`;
      const verification = await host.verify(capture.location.key, {
        'openclaw-storage.json': marker.versionId,
        [archivePath]: storedArchive.versionId,
      });
      if (
        verification.createdAt !== capture.createdAt ||
        verification.assetCount !== capture.assets.length
      )
        throw new Error('Native readback verification does not match the captured archive');
      const result: CapturedBackup = {
        schemaVersion: 1,
        operationId: job.operationId,
        runtime: host.runtime,
        capture,
        members,
        credentials,
        verification,
        objects: { 'openclaw-storage.json': marker, [archivePath]: storedArchive },
        omissions: [
          'Native volatile queues, logs and managed runtime caches are omitted; restored session recovery and scheduled work require deliberate activation review.',
        ],
        gateway: {
          initial: ownership.initial,
          restored: false,
          ...(job.archive
            ? {
                held: {
                  kind: 'archive' as const,
                  operationId: job.operationId,
                  requestDigest: backupJobDigest(job),
                },
              }
            : {}),
        },
      };
      const completed = job.archive ? parseCapturedBackup(result, job) : result;
      if (job.archive) await archive!.verified(completed);
      captured = completed;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (ownership && (!job.archive || (archiveStartedHere && !captured))) {
      try {
        if (job.archive) await archive!.restore();
        else if (ownership.initial === 'active') await host.gateway.start();
        restored = true;
        await maintenance.release();
      } catch {
        restored = false;
      }
    }
    await host.close();
  }
  if (captured) {
    captured.gateway.restored = restored;
    const result = await storage.publish(captured);
    return {
      ...result,
      operationId: job.operationId,
      gatewayRestored: restored,
      ...(job.archive ? { gatewayHeld: true } : {}),
    };
  }
  if (failure)
    throw new Error(
      !ownership
        ? 'Backup preflight failed; source service was not changed'
        : restored
          ? 'Native capture or remote verification failed; source service state was restored and no completed point was published'
          : 'Backup failed; inspect the retained maintenance record and source service before retrying',
    );
  throw new Error('Backup did not produce a complete native recovery point');
}

export async function runCaptureWorker(input: unknown, signal?: AbortSignal) {
  const job = parseBackupJob(input);
  const storage = roleCaptureStorage(job, signal);
  let host: NativeBackupHost | undefined;
  let archive: ArchiveCaptureControl | undefined;
  try {
    host = await nativeBackupHost(job, { signal });
    if (job.archive) archive = await nativeArchiveCaptureControl(job, host, signal);
    return await captureInstallation(job, host, storage, hostCaptureMaintenance(job), archive);
  } finally {
    archive?.close();
    storage.close();
  }
}

export async function runArchiveCaptureAction(
  input: unknown,
  action: 'inspect' | 'abort' | 'commit',
  signal?: AbortSignal,
) {
  if (!['inspect', 'abort', 'commit'].includes(action))
    throw new Error('Unsupported archive control action');
  const job = parseBackupJob(input);
  if (!job.archive) throw new Error('Archive control requires a whole-host capture request');
  const host = await nativeBackupHost(job, { signal });
  let archive: ArchiveCaptureControl | undefined;
  try {
    archive = await nativeArchiveCaptureControl(job, host, signal);
    if (action === 'inspect') return { operationId: job.operationId, ...(await archive.inspect()) };
    const maintenance = hostCaptureMaintenance(job);
    if (!(await maintenance.inspect()))
      throw new Error('Archive no longer owns source maintenance');
    if (action === 'abort') {
      await archive.restore();
      await maintenance.release();
      return { operationId: job.operationId, ...(await archive.inspect()) };
    }
    return {
      operationId: job.operationId,
      recordedPhase: 'destroy-committed',
      ...(await archive.commit()),
    };
  } finally {
    archive?.close();
    await host.close();
  }
}
