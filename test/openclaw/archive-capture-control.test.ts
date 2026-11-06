import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupJob as originalJob, backupCapture } from '../helpers/fixtures/backup.js';
import {
  archiveMemberIdentity,
  backupJobDigest,
  type BackupCaptureJob,
} from '../../src/openclaw/backup-contract.js';

const mocks = vi.hoisted(() => ({
  home: '',
  owner: {} as object,
  identify: vi.fn(),
  dispose: vi.fn(),
  call: vi.fn(),
  health: vi.fn(),
  prepare: vi.fn(),
  hold: vi.fn(),
  assertHeld: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('../../src/openclaw/native-control-host.js', () => ({
  createInstanceControlHost: async () => ({
    home: mocks.home,
    packageJson: '/fixture/native/package.json',
    identify: mocks.identify,
    dispose: mocks.dispose,
  }),
}));
vi.mock('../../src/openclaw/model-client.js', () => ({
  createNativeModelClient: () => ({ call: mocks.call, health: mocks.health }),
}));
vi.mock('../../src/openclaw/archive-service-hold.js', () => ({
  systemdArchiveService: () => ({}),
  archiveServiceHold: async (options: { operationId: string; requestDigest: string }) => {
    mocks.owner = {
      schemaVersion: 1,
      operationId: options.operationId,
      requestDigest: options.requestDigest,
    };
    return {
      prepare: mocks.prepare,
      hold: mocks.hold,
      assertHeld: mocks.assertHeld,
      restore: mocks.restore,
    };
  },
}));
import { nativeArchiveCaptureControl } from '../../src/openclaw/archive-capture-control.js';
import type { NativeBackupHost } from '../../src/openclaw/native-backup-host.js';

let job: BackupCaptureJob;
let work: string;
let host: NativeBackupHost;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.home = await realpath(await mkdtemp(path.join(tmpdir(), 'archive-capture-control-')));
  job = {
    ...structuredClone(originalJob),
    source: { ...originalJob.source, roleId: 'AROATESTHOSTROLE000001' },
    archive: {
      deploymentName: 'alpha',
      expectedMembers: archiveMemberIdentity(backupCapture.members),
    },
  };
  work = path.join(mocks.home, '.openclaw-aws/jobs', job.operationId);
  await mkdir(work, { recursive: true, mode: 0o700 });
  mocks.identify.mockResolvedValue('private-native-token');
  mocks.health.mockResolvedValue(undefined);
  mocks.prepare.mockImplementation(async (initial) => {
    await writeFile(
      path.join(work, 'archive-service.json'),
      JSON.stringify({ ...mocks.owner, initial }),
      { mode: 0o600 },
    );
  });
  mocks.hold.mockImplementation(async (check) => {
    if (check) await check();
  });
  mocks.assertHeld.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  mocks.call.mockImplementation(async (method) => {
    if (method === 'gateway.suspend.prepare')
      return {
        status: 'ready',
        suspensionId: '22222222-2222-2222-2222-222222222222',
        expiresAtMs: Date.now() + 120000,
        activeCount: 0,
        blockers: [],
        writeCustody: [],
      };
    if (method === 'gateway.suspend.status')
      return {
        status: 'ready',
        ownerId: 'openclaw-aws-archive:' + job.operationId,
        expiresAtMs: Date.now() + 120000,
        writeCustody: [],
      };
    if (method === 'gateway.suspend.resume') return { ok: true, status: 'running', resumed: true };
    throw new Error('Unexpected fixture RPC');
  });
  host = {
    runtime: backupCapture.runtime,
    gateway: { inspect: vi.fn(async () => 'active'), start: vi.fn() },
  } as unknown as NativeBackupHost;
});
afterEach(async () => {
  await rm(mocks.home, { recursive: true, force: true });
});
function captured() {
  const result = structuredClone(backupCapture);
  result.gateway = {
    initial: 'active',
    restored: false,
    held: { kind: 'archive', operationId: job.operationId, requestDigest: backupJobDigest(job) },
  };
  return result;
}
describe('durable archive capture control', () => {
  it('commits only a freshly held verified capture and refuses any subsequent source restart', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    await expect(controller.commit()).rejects.toThrow(/No durably verified/);
    await controller.begin('active');
    await controller.verified(captured());
    const certificate = await controller.commit();
    expect(certificate.requestDigest).toBe(backupJobDigest(job));
    expect(certificate.captureDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(controller.inspect()).resolves.toMatchObject({
      recordedPhase: 'destroy-committed',
      gatewayHeld: true,
      captureDigest: certificate.captureDigest,
    });
    await expect(controller.restore()).rejects.toThrow(/teardown was committed/);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('separates recorded verification from a failed live hold observation', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    await controller.begin('active');
    await controller.verified(captured());
    mocks.assertHeld.mockRejectedValue(new Error('unreachable or changed'));
    await expect(controller.inspect()).resolves.toMatchObject({
      recordedPhase: 'verified-held',
      gatewayHeld: false,
    });
    await expect(controller.commit()).rejects.toThrow(/unreachable/);
  });
  it('identifies the instance privately, records intent, obtains an owned hold and adopts verified metadata without recapture', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    expect(mocks.identify).toHaveBeenCalledOnce();
    expect(await controller.resume()).toBeUndefined();
    await controller.begin('active');
    const intent = JSON.parse(
      await readFile(path.join(work, 'archive-capture-started.json'), 'utf8'),
    );
    expect(intent).toMatchObject({
      operationId: job.operationId,
      requestDigest: backupJobDigest(job),
      initial: 'active',
    });
    expect(JSON.stringify(intent)).not.toContain('private-native-token');
    await controller.verified(captured());
    expect(await controller.resume()).toEqual(captured());
    await expect(controller.begin('active')).rejects.toThrow(/already started/);
    expect(mocks.hold).toHaveBeenCalledOnce();
    controller.close();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('never repeats an interrupted hold/capture and fences delayed work before owned abort', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    mocks.hold.mockRejectedValueOnce(new Error('hold outcome uncertain'));
    await expect(controller.begin('active')).rejects.toThrow(/uncertain/);
    await expect(controller.resume()).rejects.toThrow(/never recapture/);
    await controller.restore();
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(mocks.call.mock.calls.some(([method]) => method === 'gateway.suspend.resume')).toBe(
      true,
    );
    expect(
      JSON.parse(await readFile(path.join(work, 'archive-capture-aborted.json'), 'utf8'))
        .requestDigest,
    ).toBe(backupJobDigest(job));
    await expect(controller.begin('active')).rejects.toThrow(/aborted/);
    await expect(controller.resume()).rejects.toThrow(/aborted/);
    expect(mocks.hold).toHaveBeenCalledOnce();
  });
  it('aborts a no-service-change preparation failure without reinstalling or starting an unsupported service', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    mocks.prepare.mockRejectedValueOnce(new Error('unsupported service'));
    await expect(controller.begin('active')).rejects.toThrow(/unsupported/);
    await controller.restore();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.health).toHaveBeenCalledOnce();
    expect(host.gateway.start).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it('does not accept a changed initial source state as a successful no-write abort', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    mocks.prepare.mockRejectedValueOnce(new Error('preflight failed'));
    await expect(controller.begin('active')).rejects.toThrow();
    vi.mocked(host.gateway.inspect).mockResolvedValue('inactive');
    await expect(controller.restore()).rejects.toThrow(/ownership is uncertain/);
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it('does not terminate busy native work while recovering a missing short-lease reply', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    mocks.call.mockResolvedValue({
      status: 'busy',
      activeCount: 1,
      blockers: [],
      writeCustody: [],
    });
    await expect(controller.begin('active')).rejects.toThrow(/active work/);
    await controller.restore();
    expect(mocks.call.mock.calls.every(([method]) => method === 'gateway.suspend.prepare')).toBe(
      true,
    );
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledOnce();
  });
  it('refuses foreign suspension ownership during abort instead of resuming it', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    await controller.begin('active');
    mocks.call.mockResolvedValue({
      status: 'ready',
      ownerId: 'foreign',
      expiresAtMs: Date.now() + 120000,
      writeCustody: [],
    });
    await expect(controller.restore()).rejects.toThrow(/ownership is uncertain/);
    expect(mocks.call.mock.calls.some(([method]) => method === 'gateway.suspend.resume')).toBe(
      false,
    );
  });
  it('cannot adopt another immutable request or a stale hold as verified completion', async () => {
    const controller = await nativeArchiveCaptureControl(job, host);
    await controller.begin('active');
    await controller.verified(captured());
    const other = await nativeArchiveCaptureControl(
      { ...job, archive: { ...job.archive!, deploymentName: 'other' } },
      host,
    );
    await expect(other.resume()).rejects.toThrow(/another immutable request/);
    mocks.assertHeld.mockRejectedValueOnce(new Error('Gateway resumed unexpectedly'));
    await expect(controller.resume()).rejects.toThrow(/unexpectedly/);
  });
  it('closes instance clients when role identification fails before host mutation', async () => {
    mocks.identify.mockRejectedValueOnce(new Error('wrong instance role'));
    await expect(nativeArchiveCaptureControl(job, host)).rejects.toThrow(/wrong instance/);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
