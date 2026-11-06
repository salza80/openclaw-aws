import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { captureRemoteCommand } from '../../src/operations/backup.js';
import { recoveryRemoteCommand } from '../../src/aws/recovery-delivery.js';
import { backupJob } from '../helpers/fixtures/backup.js';

function delivery(sha256: string) {
  return captureRemoteCommand(
    backupJob,
    {
      digest: 'b'.repeat(64),
      files: [{ name: 'worker.js', key: 'artifact', versionId: 'version', sha256 }],
    },
    { key: 'request', versionId: 'request-version', sha256 },
  );
}
describe('SSM artifact delivery on hosts with a private root AWS CLI', () => {
  it.each(['stage', 'clone'] as const)(
    'delivers the %s recovery worker with pinned state paths without running downloaded code as root',
    async (mode) => {
      const script = recoveryRemoteCommand({
        operationId: backupJob.operationId,
        region: 'eu-central-1',
        account: backupJob.source.account,
        bucket: backupJob.settings.bucket,
        pluginDirectory: backupJob.pluginDirectory,
        worker: 'restore-worker.js',
        mode,
        artifact: {
          digest: 'b'.repeat(64),
          files: [
            {
              name: 'restore-worker.js',
              key: 'tool',
              versionId: 'version',
              sha256: 'a'.repeat(64),
            },
          ],
        },
        request: { key: 'request', versionId: 'version', sha256: 'a'.repeat(64) },
      });
      expect(script.slice(script.indexOf('sudo -H -u ubuntu'))).toContain(
        'OPENCLAW_STATE_DIR=/home/ubuntu/.openclaw',
      );
      expect(script).toContain('restore-worker.js');
      expect(script).toContain(mode === 'clone' ? '--lock-clone' : '--lock');
      expect(script.slice(0, script.indexOf('sudo -H -u ubuntu'))).not.toContain('node ');
      await execa('/bin/bash', ['-n', '-c', script]);
    },
  );
  it('retrieves/checks code before handing it to the unprivileged native worker', async () => {
    const script = delivery('a'.repeat(64));
    const handoff = script.indexOf('sudo -H -u ubuntu');
    expect(handoff).toBeGreaterThan(0);
    expect(script.slice(0, handoff)).toContain('HOME=/root');
    expect(script.slice(0, handoff)).toContain('aws s3api get-object');
    expect(script.slice(0, handoff)).toContain('chown -R ubuntu:ubuntu');
    expect(script.slice(handoff)).not.toContain('aws s3api');
    expect(script.slice(handoff)).toContain('HOME=/home/ubuntu');
    await execa('/bin/bash', ['-n', '-c', script]);
  });
  it('executes the emitted checksum check and rejects changed delivery bytes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'openclaw-delivery-'));
    const body = Buffer.from('verified worker fixture');
    const script = delivery(createHash('sha256').update(body).digest('hex'));
    const checksum = script.split('\n').find((line) => line.startsWith("printf '%s  %s"));
    expect(checksum).toBeDefined();
    try {
      await writeFile(path.join(directory, 'artifact-0'), body);
      const check =
        process.platform === 'darwin'
          ? checksum!.replace(
              'sha256sum --check --status',
              '/usr/bin/shasum -a 256 --check --status',
            )
          : checksum!;
      const options = {
        env: { HOME: directory, PATH: process.env.PATH, delivery_dir: directory },
        extendEnv: false,
      };
      await execa('/bin/bash', ['--noprofile', '--norc', '-c', check], options);
      await writeFile(path.join(directory, 'artifact-0'), 'corrupt');
      await expect(
        execa('/bin/bash', ['--noprofile', '--norc', '-c', check], options),
      ).rejects.toMatchObject({
        exitCode: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
