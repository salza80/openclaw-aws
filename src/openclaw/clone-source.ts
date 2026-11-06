import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { object, type BackupMember } from './backup-contract.js';
import { clonePolicyFromConfig } from './clone-policy.js';
import type { RestoreAssetMove } from './restore-layout.js';

const inside = (root: string, value: string) => value === root || value.startsWith(`${root}/`);

/** Resolve source links in the archived namespace, never through the live filesystem. */
export async function archivedClonePath(options: {
  original: string;
  moves: RestoreAssetMove[];
  stagingDirectory: string;
}): Promise<{ source: string; original: string }> {
  const staging = await realpath(options.stagingDirectory);
  let original = path.posix.resolve('/home/ubuntu', options.original);
  for (let links = 0; links < 40; links++) {
    const move = options.moves
      .filter((item) => inside(item.destination, original))
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    if (!move)
      throw new Error('Clone configuration references content outside the verified backup');
    const source = path.resolve(move.source, path.posix.relative(move.destination, original));
    if (!inside(staging, source)) throw new Error('Clone configuration escaped verified staging');
    let current = staging;
    let redirected = false;
    const segments = path.relative(staging, source).split(path.sep);
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        // Links in the archive prefix itself cannot be assigned a source namespace.
        if (!inside(move.source, current)) throw new Error('Clone staging has a linked ancestor');
        const virtual = path.posix.join(move.destination, path.relative(move.source, current));
        const target = await readlink(current);
        original = path.posix.resolve(
          path.posix.dirname(virtual),
          target,
          ...segments.slice(index + 1),
        );
        redirected = true;
        break;
      }
      if (index < segments.length - 1 && !info.isDirectory())
        throw new Error('Clone configuration has a non-directory ancestor');
    }
    if (!redirected) return { source, original };
  }
  throw new Error('Clone configuration has a cyclic or excessive archived link chain');
}

/** Rewrite include references into a private view. Native OpenClaw still owns
 * include merging and source-form interpretation. No source module is executed.
 */
export async function prepareCloneConfigView(options: {
  configurationPath: string;
  moves: RestoreAssetMove[];
  stagingDirectory: string;
  viewDirectory: string;
  parse: (text: string) => unknown;
}): Promise<string> {
  const completed = new Map<string, string>();
  const active = new Set<string>();
  let files = 0;
  let totalBytes = 0;
  const visit = async (original: string, depth: number): Promise<string> => {
    if (depth > 16) throw new Error('Clone configuration include depth exceeds its limit');
    const resolved = await archivedClonePath({ ...options, original });
    if (active.has(resolved.original)) throw new Error('Clone configuration has cyclic includes');
    const existing = completed.get(resolved.original);
    if (existing) return existing;
    if (++files > 64) throw new Error('Clone configuration include count exceeds its limit');
    const destination = path.join(options.viewDirectory, `config-${files}.json`);
    active.add(resolved.original);
    const file = await open(resolved.source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      const before = await file.stat();
      totalBytes += before.size;
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 1024 * 1024 ||
        totalBytes > 8 * 1024 * 1024
      )
        throw new Error('Clone configuration file is unsupported or exceeds its limit');
      const text = await file.readFile('utf8');
      const after = await file.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error('Clone configuration changed during inspection');
      value = options.parse(text);
    } finally {
      await file.close();
    }
    const rewrite = async (node: unknown, nested = 0): Promise<unknown> => {
      if (nested > 100) throw new Error('Clone configuration nesting exceeds its limit');
      if (Array.isArray(node)) {
        const result: unknown[] = [];
        for (const item of node) result.push(await rewrite(item, nested + 1));
        return result;
      }
      if (!node || typeof node !== 'object') return node;
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, field] of Object.entries(node)) {
        if (key !== '$include') result[key] = await rewrite(field, nested + 1);
        else {
          const includes = Array.isArray(field) ? field : [field];
          if (
            !includes.length ||
            includes.length > 64 ||
            includes.some(
              (item) =>
                typeof item !== 'string' || !item || item.length > 4096 || item.includes('\0'),
            )
          )
            throw new Error('Clone configuration has unsupported include references');
          const rewritten: string[] = [];
          for (const include of includes as string[])
            rewritten.push(
              await visit(
                path.posix.resolve(path.posix.dirname(resolved.original), include),
                depth + 1,
              ),
            );
          result[key] = Array.isArray(field) ? rewritten : rewritten[0];
        }
      }
      return result;
    };
    await writeFile(destination, JSON.stringify(await rewrite(value)), { flag: 'wx', mode: 0o600 });
    active.delete(resolved.original);
    completed.set(resolved.original, destination);
    return destination;
  };
  return visit(options.configurationPath, 0);
}

/** Inspect only verified staged source configuration in an isolated native reader.
 * Source .env, executable SecretRefs, plugin entrypoints and the caller's AWS/model
 * environment are never loaded into the inspection process.
 */
export async function readCloneSourcePolicy(options: {
  configurationPath: string;
  members: BackupMember[];
  moves: RestoreAssetMove[];
  stagingDirectory: string;
  nativePackageJson?: string;
  signal?: AbortSignal;
}) {
  const packageJson =
    options.nativePackageJson ??
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/openclaw/package.json');
  if (
    process.version !== `v${OPENCLAW_NODE_VERSION}` ||
    JSON.parse(await readFile(packageJson, 'utf8')).version !== OPENCLAW_VERSION
  )
    throw new Error('Clone inspection requires the supported pinned native runtime');
  const require = createRequire(packageJson);
  const parser = require('json5') as { parse: (text: string) => unknown };
  const scratch = await mkdtemp(path.join(tmpdir(), 'openclaw-clone-config-'));
  let phase = 'archived configuration includes';
  try {
    const configuration = await prepareCloneConfigView({
      ...options,
      viewDirectory: scratch,
      parse: parser.parse,
    });
    phase = 'isolated native source read';
    const script = `import { pathToFileURL } from 'node:url';
      const sdk = await import(pathToFileURL(process.argv[1]).href);
      const {snapshot} = await sdk.readConfigFileSnapshotForWrite({skipPluginValidation:true,observe:false});
      if (!snapshot.exists || !snapshot.authoredConfig) throw new Error('No authored source configuration');
      process.stdout.write(JSON.stringify(snapshot.authoredConfig));`;
    const result = await execa(
      process.execPath,
      ['--input-type=module', '-e', script, require.resolve('openclaw/plugin-sdk/config-mutation')],
      {
        env: {
          HOME: scratch,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          OPENCLAW_CONFIG_PATH: configuration,
          OPENCLAW_STATE_DIR: path.join(scratch, 'state'),
          OPENCLAW_HIDE_BANNER: '1',
          NO_COLOR: '1',
          OPENCLAW_DEFER_SHELL_ENV_FALLBACK: '1',
        },
        extendEnv: false,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        cancelSignal: options.signal,
      },
    );
    phase = 'supported source policy';
    const policy = clonePolicyFromConfig(object(JSON.parse(result.stdout)), options.members);
    const credentialPaths = new Set(policy.credentialPaths);
    phase = 'archived credential exclusions';
    for (const original of policy.credentialPaths) {
      // Missing files remain excluded by their declared name. A referenced link
      // must also exclude its actual archived target when it is in the backup.
      try {
        credentialPaths.add((await archivedClonePath({ ...options, original })).original);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    return { ...policy, credentialPaths: [...credentialPaths].sort() };
  } catch {
    throw new Error(
      `Clone source policy inspection failed during ${phase}; no source configuration or credentials were published`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
