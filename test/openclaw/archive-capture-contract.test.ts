import { describe, expect, it } from 'vitest';
import {
  archiveMemberIdentity,
  assertArchiveRoster,
  backupJobDigest,
  parseBackupJob,
  parseCapturedBackup,
  type BackupCaptureJob,
} from '../../src/openclaw/backup-contract.js';
import { backupJob, backupCapture } from '../helpers/fixtures/backup.js';

function fixture() {
  const job: BackupCaptureJob = {
    ...structuredClone(backupJob),
    source: { ...backupJob.source, roleId: 'AROATESTHOSTROLE000001' },
    archive: {
      deploymentName: 'alpha',
      expectedMembers: archiveMemberIdentity(backupCapture.members),
    },
  };
  const captured = structuredClone(backupCapture);
  captured.gateway = {
    initial: 'active',
    restored: false,
    held: { kind: 'archive', operationId: job.operationId, requestDigest: backupJobDigest(job) },
  };
  return { job, captured };
}
describe('whole-host archive capture contract', () => {
  it('binds the current immutable host, complete roster and held capture to the same request', () => {
    const { job, captured } = fixture();
    expect(parseBackupJob(job)).toEqual(job);
    expect(parseCapturedBackup(captured, job).gateway).toEqual(captured.gateway);
    const reordered = {
      ...job,
      archive: { ...job.archive!, expectedMembers: [...job.archive!.expectedMembers].reverse() },
    };
    expect(backupJobDigest(reordered)).toBe(backupJobDigest(job));
  });
  it('keeps ordinary verified backups separate from archive ownership', () => {
    expect(parseCapturedBackup(backupCapture, backupJob).gateway).toEqual(backupCapture.gateway);
    const { captured } = fixture();
    expect(() => parseCapturedBackup(captured, backupJob)).toThrow(/Ordinary backup/);
  });
  it('refuses unrelated or changed agents/roots rather than permitting partial-host deletion', () => {
    const { job, captured } = fixture();
    const other = {
      id: 'unrelated',
      workspace: '/home/ubuntu/other',
      agentDir: '/home/ubuntu/.openclaw/agents/other/agent',
    };
    expect(() =>
      assertArchiveRoster(job.archive!.expectedMembers, [...captured.members, other]),
    ).toThrow(/roster changed/);
    expect(() => assertArchiveRoster(job.archive!.expectedMembers, [])).toThrow(/roster changed/);
    expect(() =>
      assertArchiveRoster(job.archive!.expectedMembers, [
        { ...captured.members[0], workspace: other.workspace },
      ]),
    ).toThrow(/roster changed/);
  });
  it('does not accept an ordinary capture or a hold from another request as archive completion', () => {
    const { job, captured } = fixture();
    expect(() => parseCapturedBackup(backupCapture, job)).toThrow();
    captured.gateway.held!.requestDigest = 'b'.repeat(64);
    expect(() => parseCapturedBackup(captured, job)).toThrow(/held-source proof/);
    captured.gateway.held!.requestDigest = backupJobDigest(job);
    captured.gateway.restored = true;
    expect(() => parseCapturedBackup(captured, job)).toThrow(/held-source proof/);
  });
  it('validates archive deployment identity and refuses a missing approved roster', () => {
    const { job } = fixture();
    expect(() =>
      parseBackupJob({ ...job, archive: { ...job.archive, deploymentName: '../foreign' } }),
    ).toThrow();
    expect(() =>
      parseBackupJob({ ...job, archive: { ...job.archive, expectedMembers: [] } }),
    ).toThrow(/empty/);
    expect(() =>
      parseBackupJob({ ...job, source: { ...job.source, account: '999999999999' } }),
    ).toThrow();
  });
});
