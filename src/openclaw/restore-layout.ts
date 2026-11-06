import { lstat, mkdir, open, readFile, readdir, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { object, textField, type CapturedBackup } from './backup-contract.js';

const inside = (root: string, value: string) => value === root || value.startsWith(`${root}/`);
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const canonical = (value: unknown) => {
  const result = textField(value);
  if (!path.posix.isAbsolute(result) || path.posix.normalize(result) !== result)
    throw new Error('Restore requires canonical absolute Linux paths');
  return result;
};

export interface RestoreAssetMove {
  source: string;
  destination: string;
}

/** Use the verified native manifest, rather than reconstructing payload paths. */
export function planRestoreLayout(options: {
  manifest: unknown;
  capture: CapturedBackup;
  stagingDirectory: string;
  home?: string;
}): RestoreAssetMove[] {
  const home = canonical(options.home ?? '/home/ubuntu');
  const staging = canonical(options.stagingDirectory);
  const state = `${home}/.openclaw`;
  const manifest = object(options.manifest);
  const root = textField(manifest.archiveRoot, 256);
  if (
    root !== options.capture.verification.archiveRoot ||
    root.includes('/') ||
    ['.', '..'].includes(root)
  )
    throw new Error('Restored manifest does not match the verified archive root');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets))
    throw new Error('Unsupported native restore manifest');
  const sourcePaths: string[] = [];
  const moves = manifest.assets.map((value) => {
    const asset = object(value);
    const destination = canonical(asset.sourcePath);
    const archivePath = textField(asset.archivePath);
    if (
      !archivePath.startsWith(`${root}/payload/`) ||
      path.posix.normalize(archivePath) !== archivePath ||
      archivePath.includes('\\')
    )
      throw new Error('Native asset is outside the verified staging payload');
    if (
      !inside(home, destination) ||
      destination === home ||
      inside(`${home}/.openclaw-aws`, destination) ||
      inside(`${home}/.ssh`, destination) ||
      destination
        .split('/')
        .slice(home.split('/').length)
        .some((part) => part.startsWith('.') && part !== '.openclaw')
    )
      throw new Error('Restore requires an explicitly supported Ubuntu data path');
    if (inside(destination, staging) || inside(staging, destination))
      throw new Error('Restore staging overlaps a live destination');
    if (
      !options.capture.capture.assets.some(
        (saved) => saved.kind === asset.kind && saved.sourcePath === destination,
      )
    )
      throw new Error('Restored asset differs from the completed recovery inventory');
    if (sourcePaths.some((other) => inside(other, destination) || inside(destination, other)))
      throw new Error('Overlapping native restore assets require a supported migration');
    sourcePaths.push(destination);
    return { source: `${staging}/${archivePath}`, destination };
  });
  if (
    moves.length !== options.capture.capture.assets.length ||
    !manifest.assets.some(
      (value) => object(value).kind === 'state' && object(value).sourcePath === state,
    ) ||
    options.capture.credentials.configurationPath !== `${state}/openclaw.json`
  )
    throw new Error(
      'Restore requires the supported default Ubuntu configuration and complete asset inventory',
    );
  for (const member of options.capture.members)
    for (const value of [member.workspace, member.agentDir]) {
      const rootPath = canonical(value);
      if (!moves.some((move) => inside(move.destination, rootPath)))
        throw new Error('Restore inventory does not cover every member');
    }
  return moves;
}

export async function assertDirectoryChain(directory: string, root: string, create: boolean) {
  if (!inside(root, directory)) throw new Error('Restore path escaped its owned root');
  const segments = path.relative(root, directory).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!create || !missing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022
    )
      throw new Error('Restore path has an unsafe or foreign-owned directory');
  }
}

interface MoveRecord extends RestoreAssetMove {
  dev: number;
  ino: number;
}
interface LayoutJournal {
  schemaVersion: 1;
  operationId: string;
  assets: RestoreAssetMove[];
  moves: MoveRecord[];
}

/** Move only native-verified data. The freshly installed executable tree stays in place.
 * A private intent journal makes an interrupted rename identifiable by inode on retry.
 * Caller holds the host maintenance lock and keeps the Gateway persistently masked.
 */
export async function installRestoreLayout(options: {
  operationId: string;
  moves: RestoreAssetMove[];
  journal: string;
  home?: string;
}): Promise<{ preservedRuntime: true; moved: number }> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.operationId))
    throw new Error('Invalid restore layout operation');
  const home = canonical(options.home ?? '/home/ubuntu');
  const state = `${home}/.openclaw`;
  await assertDirectoryChain(path.dirname(options.journal), home, false);
  let journal: LayoutJournal | undefined;
  try {
    const stat = await lstat(options.journal);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 1024 * 1024
    )
      throw new Error('Restore layout journal is unsafe');
    journal = JSON.parse(await readFile(options.journal, 'utf8')) as LayoutJournal;
    if (
      journal.schemaVersion !== 1 ||
      journal.operationId !== options.operationId ||
      !isDeepStrictEqual(journal.assets, options.moves) ||
      !Array.isArray(journal.moves)
    )
      throw new Error('Another layout operation owns this target');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (!journal) {
    const moves: MoveRecord[] = [];
    for (const asset of options.moves) {
      await assertDirectoryChain(path.dirname(asset.source), home, false);
      const stat = await lstat(asset.source);
      if ((!stat.isDirectory() && !stat.isFile()) || stat.uid !== process.getuid?.())
        throw new Error('Restore asset root is unsafe');
      let expanded = [asset];
      if (asset.destination === state) {
        await assertDirectoryChain(state, home, false);
        // tools/bin are owned by the pinned installer; archived executable wrappers are not adopted.
        expanded = (await readdir(asset.source))
          .filter((name) => !['tools', 'bin'].includes(name))
          .map((name) => ({ source: `${asset.source}/${name}`, destination: `${state}/${name}` }));
        for (const name of await readdir(state)) {
          if (['tools', 'bin'].includes(name)) continue;
          const filename = `${state}/${name}`;
          const entry = await lstat(filename);
          if (
            name !== 'logs' ||
            !entry.isDirectory() ||
            entry.isSymbolicLink() ||
            (await readdir(filename)).length
          )
            throw new Error('Restore target already contains native data');
          if (expanded.some((move) => move.destination === filename)) await rmdir(filename);
        }
      }
      for (const move of expanded) {
        await assertDirectoryChain(path.dirname(move.destination), home, true);
        try {
          await lstat(move.destination);
          throw new Error('Restore destination already exists');
        } catch (error) {
          if (!missing(error)) throw error;
        }
        const entry = await lstat(move.source);
        const parent = await lstat(path.dirname(move.destination));
        if (entry.dev !== parent.dev)
          throw new Error('Restore data must be on the target filesystem');
        moves.push({ ...move, dev: entry.dev, ino: entry.ino });
      }
    }
    journal = { schemaVersion: 1, operationId: options.operationId, assets: options.moves, moves };
    const file = await open(options.journal, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(journal));
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(path.dirname(options.journal), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  for (const move of journal.moves) {
    await assertDirectoryChain(path.dirname(move.destination), home, false);
    await assertDirectoryChain(path.dirname(move.source), home, false);
    let source;
    try {
      source = await lstat(move.source);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (source) {
      if (source.dev !== move.dev || source.ino !== move.ino)
        throw new Error('Staged restore data changed');
      try {
        await lstat(move.destination);
        throw new Error('Restore destination appeared during installation');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await rename(move.source, move.destination);
    }
    const installed = await lstat(move.destination);
    if (installed.dev !== move.dev || installed.ino !== move.ino)
      throw new Error('Restore destination does not belong to this operation');
  }
  return { preservedRuntime: true, moved: journal.moves.length };
}
