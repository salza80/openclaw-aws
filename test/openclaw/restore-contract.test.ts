import { describe, expect, it } from 'vitest';
import { parseRestoreJob } from '../../src/openclaw/restore-contract.js';
import { restoreJobFixture } from '../helpers/fixtures/backup.js';
describe('restore worker request boundary', () => {
  it('preserves pinned old vault identities for a new same-account region/role', () => {
    const parsed = parseRestoreJob(restoreJobFixture);
    expect(parsed.target.region).toBe('us-east-1');
    expect(parsed.backup.job.settings.region).toBe('eu-central-1');
    expect(parsed.target.roleId).not.toBe(parsed.backup.job.source.roleId);
  });
  it('refuses foreign target identities, arbitrary executable paths and incompatible runtime snapshots', () => {
    for (const mutate of [
      (job: typeof restoreJobFixture) => {
        job.target.account = '999999999999';
      },
      (job: typeof restoreJobFixture) => {
        job.target.stackId = job.target.stackId.replace('restored/', 'another/');
      },
      (job: typeof restoreJobFixture) => {
        job.target.instanceId = 'other';
      },
      (job: typeof restoreJobFixture) => {
        job.pluginDirectory = '/tmp/arbitrary';
      },
      (job: typeof restoreJobFixture) => {
        job.bootstrap.runtime.node = '25.0.0';
      },
      (job: typeof restoreJobFixture) => {
        job.backup.capture.operationId = '33333333-3333-3333-3333-333333333333';
      },
    ]) {
      const job = structuredClone(restoreJobFixture);
      mutate(job);
      expect(() => parseRestoreJob(job)).toThrow();
    }
  });
});
