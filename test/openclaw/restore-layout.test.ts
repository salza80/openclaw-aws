import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { backupCapture, backupId } from '../helpers/fixtures/backup.js';
import { installRestoreLayout, planRestoreLayout } from '../../src/openclaw/restore-layout.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function manifest() {
  return {
    schemaVersion: 1,
    archiveRoot: 'archive',
    assets: backupCapture.capture.assets.map((asset) => ({
      ...asset,
      archivePath: `archive/payload/posix${asset.sourcePath}`,
    })),
  };
}
describe('native restored asset adoption', () => {
  it('uses the verified manifest for state and custom workspace paths', () => {
    const moves = planRestoreLayout({
      manifest: manifest(),
      capture: backupCapture,
      stagingDirectory: '/home/ubuntu/.openclaw-aws/staging',
    });
    expect(moves).toEqual(
      backupCapture.capture.assets.map((asset) => ({
        source: `/home/ubuntu/.openclaw-aws/staging/archive/payload/posix${asset.sourcePath}`,
        destination: asset.sourcePath,
      })),
    );
  });
  it('refuses changed inventories, missing members, traversal, protected paths and unsupported source layouts', () => {
    for (const change of [
      (m: ReturnType<typeof manifest>) => {
        m.archiveRoot = '../archive';
      },
      (m: ReturnType<typeof manifest>) => {
        m.assets[0].archivePath = 'archive/payload/../../escape';
      },
      (m: ReturnType<typeof manifest>) => {
        m.assets[1].sourcePath = '/etc/cron.d';
      },
      (m: ReturnType<typeof manifest>) => {
        m.assets.pop();
      },
      (m: ReturnType<typeof manifest>) => {
        m.assets[1].sourcePath = '/home/ubuntu/.ssh';
      },
    ]) {
      const value = manifest();
      change(value);
      expect(() =>
        planRestoreLayout({
          manifest: value,
          capture: backupCapture,
          stagingDirectory: '/home/ubuntu/.openclaw-aws/staging',
        }),
      ).toThrow();
    }
    const capture = structuredClone(backupCapture);
    capture.members[0].workspace = '/home/ubuntu/missing';
    expect(() =>
      planRestoreLayout({
        manifest: manifest(),
        capture,
        stagingDirectory: '/home/ubuntu/.openclaw-aws/staging',
      }),
    ).toThrow('every member');
  });
  async function fixture() {
    const home = await mkdtemp(path.join(tmpdir(), 'restore-layout-'));
    directories.push(home);
    const management = path.join(home, '.openclaw-aws');
    const state = path.join(home, '.openclaw');
    const staged = path.join(management, 'staged-state');
    await mkdir(management, { mode: 0o700 });
    await mkdir(state);
    await mkdir(staged);
    for (const root of [state, staged]) {
      await mkdir(path.join(root, 'bin'));
      await mkdir(path.join(root, 'logs'));
    }
    await mkdir(path.join(state, 'tools'));
    await writeFile(path.join(state, 'tools/node'), 'pinned-runtime');
    await writeFile(path.join(state, 'bin/openclaw'), 'fresh-wrapper');
    await writeFile(path.join(staged, 'bin/openclaw'), 'archived-wrapper');
    await writeFile(path.join(staged, 'openclaw.json'), '{"restored":true}');
    await writeFile(path.join(staged, 'logs/native.log'), 'historical-log');
    const custom = path.join(management, 'staged-workspace');
    await mkdir(custom);
    await writeFile(path.join(custom, 'work.txt'), 'saved-work');
    return {
      home,
      state,
      staged,
      journal: path.join(management, 'layout.json'),
      operationId: backupId,
      moves: [
        { source: staged, destination: state },
        { source: custom, destination: path.join(home, 'workspace') },
      ],
    };
  }
  it('moves verified data while preserving the fresh runtime, supports completed retry and never copies database bytes', async () => {
    const options = await fixture();
    expect(await installRestoreLayout(options)).toMatchObject({ preservedRuntime: true });
    expect(await readFile(path.join(options.state, 'tools/node'), 'utf8')).toBe('pinned-runtime');
    expect(await readFile(path.join(options.state, 'bin/openclaw'), 'utf8')).toBe('fresh-wrapper');
    expect(await readFile(path.join(options.state, 'openclaw.json'), 'utf8')).toBe(
      '{"restored":true}',
    );
    expect(await readFile(path.join(options.state, 'logs/native.log'), 'utf8')).toBe(
      'historical-log',
    );
    expect(await readFile(path.join(options.home, 'workspace/work.txt'), 'utf8')).toBe(
      'saved-work',
    );
    expect((await lstat(options.journal)).mode & 0o077).toBe(0);
    await expect(installRestoreLayout(options)).resolves.toMatchObject({ preservedRuntime: true });
  });
  it('resumes an interrupted rename only when the destination inode matches the durable intent', async () => {
    const options = await fixture();
    const move = options.moves[1];
    const stat = await lstat(move.source);
    await writeFile(
      options.journal,
      JSON.stringify({
        schemaVersion: 1,
        operationId: options.operationId,
        assets: options.moves,
        moves: [{ ...move, dev: stat.dev, ino: stat.ino }],
      }),
      { mode: 0o600 },
    );
    await rename(move.source, move.destination);
    await expect(installRestoreLayout(options)).resolves.toMatchObject({ moved: 1 });
    await rename(move.destination, `${move.destination}-previous`);
    await mkdir(move.destination);
    await expect(installRestoreLayout(options)).rejects.toThrow('does not belong');
  });
  it('refuses an occupied target before moving state and refuses symlink destination ancestors', async () => {
    const options = await fixture();
    await writeFile(path.join(options.state, 'openclaw.json'), 'existing');
    await expect(installRestoreLayout(options)).rejects.toThrow('already contains');
    expect(await readFile(path.join(options.staged, 'openclaw.json'), 'utf8')).toContain(
      'restored',
    );
    await rm(path.join(options.state, 'openclaw.json'));
    await symlink(options.state, path.join(options.home, 'alias'));
    options.moves[1].destination = path.join(options.home, 'alias/workspace');
    await expect(installRestoreLayout(options)).rejects.toThrow('unsafe');
  });
  it('does not adopt a journal from another operation', async () => {
    const options = await fixture();
    await installRestoreLayout(options);
    options.operationId = '22222222-2222-2222-2222-222222222222';
    await expect(installRestoreLayout(options)).rejects.toThrow('Another layout');
  });
  it('refuses writable-by-others management paths before installing restored data', async () => {
    const options = await fixture();
    await chmod(path.dirname(options.journal), 0o777);
    await expect(installRestoreLayout(options)).rejects.toThrow('unsafe');
    expect(await readFile(path.join(options.staged, 'openclaw.json'), 'utf8')).toContain(
      'restored',
    );
    await chmod(path.dirname(options.journal), 0o700);
  });
});
