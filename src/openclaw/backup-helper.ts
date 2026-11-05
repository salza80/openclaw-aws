import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import type { AwsTarget } from '../aws/target.js';

const helperSpec = new URL('../../templates/openclaw/native-helper/', import.meta.url);
const pluginFiles = new URL('../../dist/native-plugins/aws-s3/', import.meta.url);
const artifactFiles = [
  'index.js',
  'index.js.LEGAL.txt',
  'THIRD-PARTY-LICENSES.txt',
  'package.json',
  'openclaw.plugin.json',
];
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const cacheRoot = () => path.join(homedir(), '.cache', 'openclaw-aws');
interface NativeHelper {
  node: string;
  entrypoint: string;
  plugin: string;
}

async function exists(filename: string) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error('Native helper cache must be a private directory owned by the current user');
}
async function download(url: string, filename: string, maximumBytes: number) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body)
    throw new Error('Unable to download the pinned native helper runtime');
  let size = 0;
  async function* limited() {
    for await (const chunk of response.body!) {
      size += chunk.byteLength;
      if (size > maximumBytes)
        throw new Error('Native helper runtime download exceeded its size limit');
      yield chunk;
    }
    if (!size) throw new Error('Native helper runtime download was empty');
  }
  await pipeline(limited(), createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
}
function isolatedEnvironment(home: string, node: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ''}`,
    NO_COLOR: '1',
    OPENCLAW_HIDE_BANNER: '1',
    AWS_CONFIG_FILE: path.join(home, 'empty-aws-config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'empty-aws-credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  if (process.platform === 'win32' && process.env.SystemRoot)
    environment.SystemRoot = process.env.SystemRoot;
  return environment;
}
async function managedNode(root: string): Promise<{ node: string; npm: string }> {
  const suppliedNode = process.execPath;
  const suppliedNpm =
    process.platform === 'win32'
      ? path.join(path.dirname(suppliedNode), 'node_modules/npm/bin/npm-cli.js')
      : path.resolve(path.dirname(suppliedNode), '../lib/node_modules/npm/bin/npm-cli.js');
  if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    if (process.version === `v${OPENCLAW_NODE_VERSION}` && (await exists(suppliedNpm)))
      return { node: suppliedNode, npm: suppliedNpm };
    throw new Error(
      `Run this command with Node ${OPENCLAW_NODE_VERSION} and npm; automatic native-helper runtime installation supports Linux/macOS x64/arm64`,
    );
  }
  const directory = path.join(
    root,
    `node-v${OPENCLAW_NODE_VERSION}-${process.platform}-${process.arch}`,
  );
  const node = path.join(directory, 'bin/node');
  const npm = path.join(directory, 'lib/node_modules/npm/bin/npm-cli.js');
  if (!(await exists(node))) {
    const staging = await mkdtemp(path.join(root, '.node-install-'));
    try {
      const archive = `node-v${OPENCLAW_NODE_VERSION}-${process.platform}-${process.arch}.tar.gz`;
      const base = `https://nodejs.org/dist/v${OPENCLAW_NODE_VERSION}`;
      await download(`${base}/SHASUMS256.txt`, path.join(staging, 'checksums'), 128 * 1024);
      const expected = (await readFile(path.join(staging, 'checksums'), 'utf8'))
        .split('\n')
        .find((line) => line.trim().endsWith(`  ${archive}`))
        ?.split(/\s+/)[0];
      if (!expected || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error('Pinned native runtime checksum was not published');
      const tarball = path.join(staging, 'runtime.tar.gz');
      await download(`${base}/${archive}`, tarball, 200 * 1024 * 1024);
      const checksum = createHash('sha256');
      for await (const chunk of createReadStream(tarball)) checksum.update(chunk);
      if (checksum.digest('hex') !== expected)
        throw new Error('Pinned native runtime checksum did not match');
      const extracted = path.join(staging, 'runtime');
      await mkdir(extracted, { mode: 0o700 });
      await execa('tar', ['-xzf', tarball, '--strip-components=1', '-C', extracted], {
        timeout: 60000,
        env: isolatedEnvironment(staging, suppliedNode),
        extendEnv: false,
      });
      await rename(extracted, directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const result = await execa(node, ['--version'], {
    timeout: 10000,
    env: isolatedEnvironment(root, node),
    extendEnv: false,
  });
  if (result.stdout !== `v${OPENCLAW_NODE_VERSION}` || !(await exists(npm)))
    throw new Error(
      'Cached native runtime is incomplete or incompatible; inspect the helper cache before retrying',
    );
  return { node, npm };
}

/** Install an explicit, lockfile-pinned backup helper. Never use a global OpenClaw. */
export async function ensureBackupHelper(
  options: { cacheDirectory?: string } = {},
): Promise<NativeHelper> {
  const root = options.cacheDirectory ?? cacheRoot();
  await privateDirectory(root);
  const manifest = await readFile(new URL('package.json', helperSpec));
  const lock = await readFile(new URL('package-lock.json', helperSpec));
  const artifacts = await Promise.all(
    artifactFiles.map((filename) => readFile(new URL(filename, pluginFiles))),
  );
  const fingerprint = hash(
    JSON.stringify([
      process.platform,
      process.arch,
      OPENCLAW_NODE_VERSION,
      hash(manifest),
      hash(lock),
      ...artifacts.map(hash),
    ]),
  );
  const directory = path.join(root, `backup-${OPENCLAW_VERSION}-${fingerprint.slice(0, 16)}`);
  const ready = path.join(directory, 'ready.json');
  const open = async () => {
    const record = JSON.parse(await readFile(ready, 'utf8'));
    const pkg = JSON.parse(
      await readFile(path.join(directory, 'node_modules/openclaw/package.json'), 'utf8'),
    );
    if (
      record.fingerprint !== fingerprint ||
      pkg.version !== OPENCLAW_VERSION ||
      typeof record.node !== 'string'
    )
      throw new Error('Cached native helper does not match the pinned installation');
    const runtime = await execa(record.node, ['--version'], {
      timeout: 10000,
      env: isolatedEnvironment(root, record.node),
      extendEnv: false,
    });
    if (runtime.stdout !== `v${OPENCLAW_NODE_VERSION}`)
      throw new Error('Cached native helper runtime differs from the pinned Node version');
    return {
      node: record.node,
      entrypoint: path.join(directory, 'node_modules/openclaw/openclaw.mjs'),
      plugin: path.join(directory, 'plugin'),
    };
  };
  if (await exists(ready)) return open();
  const lockDirectory = path.join(root, 'install.lock');
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        `Native helper installation is locked at ${lockDirectory}; wait for the installer, or verify it has exited before removing its stale lock`,
        { cause: error },
      );
    throw error;
  }
  let staging: string | undefined;
  try {
    // Another installer may have completed just before this lock was acquired.
    if (await exists(ready)) return open();
    const runtime = await managedNode(root);
    staging = await mkdtemp(path.join(root, '.backup-install-'));
    await writeFile(path.join(staging, 'package.json'), manifest, { mode: 0o600 });
    await writeFile(path.join(staging, 'package-lock.json'), lock, { mode: 0o600 });
    await execa(
      runtime.node,
      [
        runtime.npm,
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--cache',
        path.join(root, 'npm-cache'),
        '--userconfig',
        path.join(staging, 'empty-npmrc'),
        '--globalconfig',
        path.join(staging, 'empty-global-npmrc'),
      ],
      {
        cwd: staging,
        env: isolatedEnvironment(staging, runtime.node),
        extendEnv: false,
        timeout: 600000,
        maxBuffer: 1024 * 1024,
      },
    );
    const pluginDirectory = path.join(staging, 'plugin');
    await mkdir(pluginDirectory, { mode: 0o700 });
    for (const filename of artifactFiles)
      await copyFile(new URL(filename, pluginFiles), path.join(pluginDirectory, filename));
    await writeFile(
      path.join(staging, 'ready.json'),
      JSON.stringify({ fingerprint, node: runtime.node }),
      { mode: 0o600 },
    );
    await rename(staging, directory);
    staging = undefined;
    return await open();
  } catch {
    throw new Error(
      'Unable to provision the pinned native backup helper; check network access, free disk space and the private helper cache',
    );
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export type NativeBackupRead =
  | { action: 'list'; namespace?: string }
  | { action: 'verify'; namespace: string; archive: string }
  | { action: 'restore'; namespace: string; archive: string; targetDirectory: string };

function readArguments(operation: NativeBackupRead): string[] {
  if (!['list', 'verify', 'restore'].includes(operation.action))
    throw new Error('Unsupported native recovery operation');
  const args = ['backup', operation.action, '--from', 'aws-vault', '--json'];
  if (operation.namespace !== undefined) {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(operation.namespace) ||
      ['.', '..'].includes(operation.namespace)
    )
      throw new Error('Invalid native backup namespace');
    args.push(`--namespace=${operation.namespace}`);
  }
  if (operation.action !== 'list') {
    if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/.test(operation.archive) || !operation.namespace)
      throw new Error('Recovery requires an explicit native archive key and namespace');
    if (operation.action === 'restore') {
      if (!path.isAbsolute(operation.targetDirectory) || operation.targetDirectory.includes('\0'))
        throw new Error('Native recovery requires an absolute fresh staging directory');
      args.push(`--target=${operation.targetDirectory}`);
    }
    args.push(operation.archive);
  }
  return args;
}

export async function runBackupHelper(options: {
  target: AwsTarget;
  operation: NativeBackupRead;
  settings: Record<string, unknown>;
  passphrase: string;
  signal?: AbortSignal;
  cacheDirectory?: string;
}): Promise<unknown> {
  const args = readArguments(options.operation);
  const helper = await ensureBackupHelper({ cacheDirectory: options.cacheDirectory });
  const directory = await mkdtemp(path.join(tmpdir(), 'openclaw-aws-recovery-'));
  try {
    const config = path.join(directory, 'openclaw.json');
    const keyInput = path.join(directory, 'key.json');
    await writeFile(keyInput, JSON.stringify({ passphrase: options.passphrase }), { mode: 0o600 });
    await writeFile(
      config,
      JSON.stringify({
        plugins: {
          allow: ['openclaw-aws-s3'],
          load: { paths: [helper.plugin] },
          entries: { 'openclaw-aws-s3': { enabled: true } },
        },
        secrets: {
          providers: { 'aws-vault-key': { source: 'file', path: keyInput, mode: 'json' } },
        },
        storage: {
          locations: {
            'aws-vault': {
              provider: 'aws-s3',
              settings: { ...options.settings, readOnly: true },
              encryption: {
                passphrase: { source: 'file', provider: 'aws-vault-key', id: '/passphrase' },
              },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const aws = await options.target.environment(30 * 60 * 1000);
    const env = isolatedEnvironment(directory, helper.node);
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_CREDENTIAL_EXPIRATION',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
    ])
      if (aws[name]) env[name] = aws[name]!;
    env.OPENCLAW_CONFIG_PATH = config;
    env.OPENCLAW_STATE_DIR = path.join(directory, 'state');
    env.OPENCLAW_AWS_BACKUP_OPERATION_ID = randomUUID();
    const result = await execa(helper.node, [helper.entrypoint, ...args], {
      env,
      extendEnv: false,
      timeout: 25 * 60 * 1000,
      cancelSignal: options.signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch {
    // Child failures contain environment/command/output. Never let them escape with secrets.
    throw new Error(
      'Native recovery operation failed; the recovery point was preserved. Check vault access, the retained key and compatibility before retrying',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
