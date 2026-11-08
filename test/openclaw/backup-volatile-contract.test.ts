import { describe, expect, it } from 'vitest';
import {
  assertMemberCoverage,
  parseCapture,
  parseCapturedBackup,
} from '../../src/openclaw/backup-contract.js';
import { backupCapture, backupJob } from '../helpers/fixtures/backup.js';

function fixture() {
  return {
    ...structuredClone(backupCapture.capture),
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: true,
    skipped: [
      ...backupCapture.capture.skipped,
      {
        kind: 'entry',
        sourcePath: '/home/ubuntu/.openclaw/logs/config-audit.jsonl',
        reason: 'volatile',
      },
    ],
    skippedVolatileCount: 1,
  };
}
describe('native transient backup omissions', () => {
  it('retains declared transient entries and counts through complete receipt parsing', () => {
    const capture = parseCapture(fixture());
    expect(capture.skippedVolatileCount).toBe(1);
    expect(() => assertMemberCoverage(capture, backupCapture.members)).not.toThrow();
    const result = parseCapturedBackup({ ...structuredClone(backupCapture), capture }, backupJob);
    expect(result.capture).toEqual(capture);
  });
  it.each([0, 2])('rejects a mismatched volatile count (%s)', (value) => {
    expect(() => parseCapture({ ...fixture(), skippedVolatileCount: value })).toThrow(
      'declared count',
    );
  });
  it('does not accept lost workspaces, unknown omissions or native warnings', () => {
    const input = fixture();
    expect(() =>
      parseCapture({ ...input, skipped: [{ ...input.skipped[1], kind: 'workspace' }] }),
    ).toThrow('transient entry');
    expect(() =>
      parseCapture({
        ...input,
        skippedVolatileCount: 0,
        skipped: [{ ...input.skipped[1], reason: 'vanished' }],
      }),
    ).toThrow('unsupported omission');
    expect(() => parseCapture({ ...input, warnings: ['source entry vanished'] })).toThrow(
      'warnings',
    );
    const lost = parseCapture({
      ...input,
      skipped: [{ ...input.skipped[1], sourcePath: backupCapture.members[0].agentDir }],
    });
    expect(() => assertMemberCoverage(lost, backupCapture.members)).toThrow('declared member');
  });
});
