import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createPrivateControlRecord, privateModelJson } from './model-journal.js';
import {
  backupJobDigest,
  archiveCaptureDigest,
  parseCapturedBackup,
  type BackupCaptureJob,
  type CapturedBackup,
} from './backup-contract.js';
import { createInstanceControlHost } from './native-control-host.js';
import { createNativeModelClient } from './model-client.js';
import {
  ArchiveSuspensionBusyError,
  prepareArchiveSuspension,
  assertArchiveSuspension,
  resumeArchiveSuspension,
  type ArchiveSuspension,
} from './archive-suspension.js';
import { archiveServiceHold, systemdArchiveService } from './archive-service-hold.js';
import type { NativeBackupHost } from './native-backup-host.js';

export interface ArchiveCaptureControl {
  resume(): Promise<CapturedBackup | undefined>;
  begin(initial: 'active' | 'inactive' | 'failed'): Promise<void>;
  assertHeld(): Promise<void>;
  verified(capture: CapturedBackup): Promise<void>;
  restore(): Promise<void>;
  close(): void;
  commit(): Promise<{ requestDigest: string; captureDigest: string }>;
  inspect(): Promise<{
    recordedPhase:
      | 'not-started'
      | 'capture-uncertain'
      | 'verified-held'
      | 'aborting'
      | 'aborted'
      | 'destroy-committed';
    gatewayHeld: boolean;
    captureDigest?: string;
  }>;
}

/** Same host identity/private token boundary as model/provider controls.
 * Completed native verification can be adopted without recapturing the source;
 * an interrupted capture is never repeated. Caller holds flock/maintenance.
 */
export async function nativeArchiveCaptureControl(
  job: BackupCaptureJob,
  host: NativeBackupHost,
  signal?: AbortSignal,
): Promise<ArchiveCaptureControl> {
  if (!job.archive) throw new Error('Archive capture requires an explicit whole-host plan');
  const instance = await createInstanceControlHost(
    {
      target: { ...job.source, deploymentName: job.archive.deploymentName },
      runtime: host.runtime,
    },
    signal,
  );
  try {
    const token = await instance.identify();
    const client = createNativeModelClient({
      home: instance.home,
      packageJson: instance.packageJson,
      gatewayToken: token,
      signal,
      record: async () => {},
    });
    const requestDigest = backupJobDigest(job);
    const owner = { schemaVersion: 1, operationId: job.operationId, requestDigest };
    const work = path.join(instance.home, '.openclaw-aws/jobs', job.operationId);
    const service = await archiveServiceHold({
      home: instance.home,
      operationId: job.operationId,
      requestDigest,
      service: systemdArchiveService(() => host.gateway.start()),
    });
    const read = async (name: string) => {
      try {
        const value = await privateModelJson(path.join(work, name));
        if (
          value.schemaVersion !== 1 ||
          value.operationId !== job.operationId ||
          value.requestDigest !== requestDigest
        )
          throw new Error('Archive capture record belongs to another immutable request');
        return value;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
    };
    const write = async (name: string, fields: object = {}) => {
      const value = { ...owner, ...fields };
      try {
        await createPrivateControlRecord(path.join(work, name), value);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        if (!isDeepStrictEqual(await read(name), value))
          throw new Error('Archive capture transition already has a different result', {
            cause: error,
          });
      }
    };
    let lease: ArchiveSuspension | undefined;
    const assertNotAborting = async () => {
      if (await read('archive-capture-abort-intent.json'))
        throw new Error('Archive capture was aborted; delayed capture/deletion was refused');
    };
    const assertHeld = async () => {
      await assertNotAborting();
      await service.assertHeld();
    };
    return {
      close: () => instance.dispose(),
      async resume() {
        await assertNotAborting();
        const started = await read('archive-capture-started.json');
        const verified = await read('archive-capture-verified.json');
        if (verified) {
          if (!started) throw new Error('Archive verification has no original capture intent');
          await assertHeld();
          const capture = parseCapturedBackup(verified.capture, job);
          if (capture.gateway.initial !== started.initial)
            throw new Error('Verified archive has a different original service state');
          return capture;
        }
        if (started)
          throw new Error(
            'Archive capture outcome is incomplete; inspect or abort, never recapture',
          );
        return;
      },
      async begin(initial) {
        await assertNotAborting();
        if (await read('archive-capture-started.json'))
          throw new Error('Archive capture already started; no native work was repeated');
        await write('archive-capture-started.json', { initial });
        await service.prepare(initial);
        if (initial === 'active') {
          await write('archive-suspension-intent.json');
          lease = await prepareArchiveSuspension(client, job.operationId);
          await write('archive-suspension.json', { lease });
        }
        await service.hold(
          lease
            ? async () => {
                await assertArchiveSuspension(client, lease!);
                return lease!;
              }
            : undefined,
        );
      },
      assertHeld,
      async inspect() {
        if (await read('archive-capture-aborted.json'))
          return { recordedPhase: 'aborted', gatewayHeld: false };
        if (await read('archive-capture-abort-intent.json'))
          return { recordedPhase: 'aborting', gatewayHeld: false };
        const capture = await read('archive-capture-verified.json');
        if (capture) {
          let gatewayHeld = false;
          try {
            await assertHeld();
            gatewayHeld = true;
          } catch {
            /* Failed live observation is not recorded completion. */
          }
          return {
            recordedPhase: (await read('archive-capture-destroy-committed.json'))
              ? 'destroy-committed'
              : 'verified-held',
            gatewayHeld,
            captureDigest: archiveCaptureDigest(parseCapturedBackup(capture.capture, job), job),
          };
        }
        return {
          recordedPhase: (await read('archive-capture-started.json'))
            ? 'capture-uncertain'
            : 'not-started',
          gatewayHeld: false,
        };
      },
      async commit() {
        await assertHeld();
        const capture = await read('archive-capture-verified.json');
        if (!capture) throw new Error('No durably verified final capture authorizes teardown');
        const captureDigest = archiveCaptureDigest(parseCapturedBackup(capture.capture, job), job);
        await write('archive-capture-destroy-committed.json');
        await assertHeld();
        return { requestDigest, captureDigest };
      },
      async verified(capture) {
        await assertHeld();
        await write('archive-capture-verified.json', {
          capture: parseCapturedBackup(capture, job),
        });
      },
      async restore() {
        if (await read('archive-capture-destroy-committed.json'))
          throw new Error('Archive teardown was committed; abort cannot restart its source');
        // This durable terminal intent fences delayed capture before restoring
        // a service. It never authorizes deletion of a source or recovery point.
        await write('archive-capture-abort-intent.json');
        if (!(await read('archive-service.json'))) {
          const started = await read('archive-capture-started.json');
          if (
            !started ||
            !['active', 'inactive', 'failed'].includes(String(started.initial)) ||
            (await read('archive-suspension-intent.json')) ||
            (await host.gateway.inspect()) !== started.initial
          )
            throw new Error('Archive preparation ownership is uncertain; source was retained');
          // Service preparation records ownership before any mutation or native
          // suspension. Absence here is a no-service-change failure, not a reason
          // to install/start a missing or unsupported native service.
          if (started.initial === 'active') await client.health();
          await write('archive-capture-aborted.json');
          return;
        }
        await service.restore();
        const recorded = await read('archive-suspension.json');
        lease ??= recorded?.lease as ArchiveSuspension | undefined;
        if (!lease && (await read('archive-suspension-intent.json'))) {
          // The public native request ID is idempotent. Explicit owned abort
          // may recover that short lease after its reply was lost. Busy work
          // means native preparation declined; it is never drained/terminated.
          try {
            lease = await prepareArchiveSuspension(client, job.operationId);
          } catch (error) {
            if (!(error instanceof ArchiveSuspensionBusyError)) throw error;
          }
        }
        if (lease) await resumeArchiveSuspension(client, lease);
        await write('archive-capture-aborted.json');
      },
    };
  } catch (error) {
    instance.dispose();
    throw error;
  }
}
