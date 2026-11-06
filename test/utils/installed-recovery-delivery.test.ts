import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
vi.mock('../../src/openclaw/commands.js', async (load) => ({
  ...(await load<object>()),
  asUbuntu: (command: string) => command,
}));
import { installedRecoveryRemoteCommand } from '../../src/aws/recovery-delivery.js';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
describe('installed recovery delivery without source access', () => {
  it.each(['activate-clone', 'archive-inspect', 'archive-abort', 'archive-commit'] as const)(
    'executes checksum-pinned %s and refuses changed bytes before execution',
    async (mode) => {
      const home = await mkdtemp(path.join(tmpdir(), 'installed-recovery-'));
      const operationId = '22222222-2222-2222-2222-222222222222';
      const pluginDirectory = '/home/ubuntu/.openclaw-aws/plugins/' + 'a'.repeat(64);
      const work = '/home/ubuntu/.openclaw-aws/jobs/' + operationId;
      const body =
        "require('node:fs').writeFileSync(process.argv[4], JSON.stringify({ok:true,mode:process.argv[2]}));";
      const request = '{"fixture":true}';
      const local = (input: string) => input.replaceAll('/home/ubuntu', home);
      try {
        await mkdir(local(pluginDirectory), { recursive: true });
        await mkdir(local(work), { recursive: true });
        const worker = mode.startsWith('archive-') ? 'worker.js' : 'restore-worker.js';
        await writeFile(local(pluginDirectory + '/' + worker), body);
        await writeFile(local(work + '/request.json'), request);
        const command = installedRecoveryRemoteCommand({
          operationId,
          pluginDirectory,
          artifact: {
            digest: 'a'.repeat(64),
            files: [{ name: worker, key: 'unused', versionId: 'unused', sha256: hash(body) }],
          },
          requestSha256: hash(request),
          mode,
        });
        expect(command).not.toContain('aws s3');
        const script = local(
          process.platform === 'darwin'
            ? command.replaceAll(
                'sha256sum --check --status',
                '/usr/bin/shasum -a 256 --check --status',
              )
            : command,
        );
        const output = await execa('/bin/bash', ['--noprofile', '--norc', '-c', script]);
        expect(JSON.parse(output.stdout)).toEqual({ ok: true, mode: '--lock-' + mode });
        await rm(local(work + '/result.json'));
        await writeFile(local(work + '/request.json'), '{"tampered":true}');
        await expect(
          execa('/bin/bash', ['--noprofile', '--norc', '-c', script]),
        ).rejects.toMatchObject({ exitCode: 1 });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
