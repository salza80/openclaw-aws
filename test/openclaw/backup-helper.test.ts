import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('execa', () => ({ execa: mocks.run }));
import { ensureBackupHelper, runBackupHelper } from '../../src/openclaw/backup-helper.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const directories: string[] = [];
async function cache() {
  const directory = await mkdtemp(path.join(tmpdir(), 'claw-helper-unit-'));
  directories.push(directory);
  // Runtime download is verified separately; mock only process execution here.
  const runtime = path.join(directory, `node-v24.22.2-${process.platform}-${process.arch}`);
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await mkdir(path.join(runtime, 'lib/node_modules/npm/bin'), { recursive: true });
  await writeFile(path.join(runtime, 'bin/node'), 'fixture');
  await writeFile(path.join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), 'fixture');
  return directory;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.run.mockImplementation(async (_node: string, args: string[], options: { cwd?: string }) => {
    if (args[0] === '--version') return { stdout: 'v24.22.2' };
    if (args.includes('ci')) {
      await mkdir(path.join(options.cwd!, 'node_modules/openclaw'), { recursive: true });
      await writeFile(
        path.join(options.cwd!, 'node_modules/openclaw/package.json'),
        JSON.stringify({ version: '2026.11.1' }),
      );
      await writeFile(path.join(options.cwd!, 'node_modules/openclaw/openclaw.mjs'), 'fixture');
      return { stdout: '' };
    }
    return { stdout: JSON.stringify({ native: true }) };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('managed native recovery helper', () => {
  it('installs the pinned lockfile and self-contained plugin once, without operator credentials', async () => {
    const directory = await cache();
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-private-value');
    vi.stubEnv('NODE_OPTIONS', '--require unwanted-hook');
    const helper = await ensureBackupHelper({ cacheDirectory: directory });
    const install = mocks.run.mock.calls.find(([, args]) => args.includes('ci'))!;
    expect(install[1]).toEqual(
      expect.arrayContaining(['--ignore-scripts', '--omit=dev', '--no-audit']),
    );
    expect(install[2]).toMatchObject({ extendEnv: false });
    expect(install[2].env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(install[2].env).not.toHaveProperty('NODE_OPTIONS');
    expect(
      JSON.parse(await readFile(path.join(helper.plugin, 'openclaw.plugin.json'), 'utf8')).contracts
        .storageProviders,
    ).toEqual(['aws-s3']);
    expect((await readdir(directory)).includes('install.lock')).toBe(false);
    expect(await ensureBackupHelper({ cacheDirectory: directory })).toEqual(helper);
    expect(mocks.run.mock.calls.filter(([, args]) => args.includes('ci'))).toHaveLength(1);
  });
  it('refuses an existing installer lock without stealing or deleting it', async () => {
    const directory = await cache();
    await mkdir(path.join(directory, 'install.lock'));
    await expect(ensureBackupHelper({ cacheDirectory: directory })).rejects.toThrow(/locked/);
    expect(await readdir(directory)).toContain('install.lock');
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects caches accessible to other local users', async () => {
    const directory = await cache();
    await chmod(directory, 0o755);
    await expect(ensureBackupHelper({ cacheDirectory: directory })).rejects.toThrow(
      /private directory/,
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('cleans failed installation state and redacts child failures', async () => {
    const directory = await cache();
    mocks.run.mockRejectedValue(new Error('PRIVATE-npm-environment-output'));
    await expect(ensureBackupHelper({ cacheDirectory: directory })).rejects.toThrow(
      'Unable to provision',
    );
    expect((await readdir(directory)).filter((name) => !name.startsWith('node-v'))).toEqual([]);
  });
  it('runs a read-only native command in a fresh private context and deletes its configuration afterwards', async () => {
    const directory = await cache();
    await ensureBackupHelper({ cacheDirectory: directory });
    const previous = mocks.run.getMockImplementation()!;
    let privateKeyPath = '';
    mocks.run.mockImplementation(async (node, args, options) => {
      if (args[0].endsWith('openclaw.mjs')) {
        const config = JSON.parse(await readFile(options.env.OPENCLAW_CONFIG_PATH, 'utf8'));
        privateKeyPath = config.secrets.providers['aws-vault-key'].path;
        expect(JSON.parse(await readFile(privateKeyPath, 'utf8')).passphrase).toBe(
          'private-vault-passphrase\0\n',
        );
        expect(config.storage.locations['aws-vault'].settings.readOnly).toBe(true);
      }
      return previous(node, args, options);
    });
    const environment = vi.fn(async () => ({
      AWS_ACCESS_KEY_ID: 'selected-key',
      AWS_SECRET_ACCESS_KEY: 'selected-private-secret',
      AWS_REGION: 'eu-central-1',
      AWS_PROFILE: 'ignored-profile',
      NODE_OPTIONS: '--require bad',
    }));
    expect(
      await runBackupHelper({
        cacheDirectory: directory,
        target: { ...testTarget, environment },
        operation: { action: 'list' },
        settings: { readOnly: false },
        passphrase: 'private-vault-passphrase\0\n',
      }),
    ).toEqual({ native: true });
    expect(environment).toHaveBeenCalledWith(30 * 60 * 1000);
    const call = mocks.run.mock.calls.at(-1)!;
    expect(call[1]).toEqual(expect.arrayContaining(['backup', 'list', '--json']));
    expect(call[2]).toMatchObject({
      extendEnv: false,
      timeout: 25 * 60 * 1000,
      env: {
        AWS_ACCESS_KEY_ID: 'selected-key',
        AWS_SECRET_ACCESS_KEY: 'selected-private-secret',
      },
    });
    expect(call[2].env).not.toHaveProperty('AWS_PROFILE');
    expect(call[2].env).not.toHaveProperty('NODE_OPTIONS');
    expect(call[2].env).not.toHaveProperty('OPENCLAW_AWS_VAULT_KEY');
    await expect(readFile(call[2].env.OPENCLAW_CONFIG_PATH)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(privateKeyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not expose private command output or credentials on native failures', async () => {
    const directory = await cache();
    await ensureBackupHelper({ cacheDirectory: directory });
    mocks.run.mockImplementation(async (_node: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'v24.22.2' };
      throw new Error('PRIVATE-native-output-and-keys');
    });
    await expect(
      runBackupHelper({
        cacheDirectory: directory,
        target: testTarget,
        operation: { action: 'list' },
        settings: {},
        passphrase: 'private',
      }),
    ).rejects.toThrow(/^Native recovery operation failed/);
    const call = mocks.run.mock.calls.at(-1)!;
    await expect(readFile(call[2].env.OPENCLAW_CONFIG_PATH)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
