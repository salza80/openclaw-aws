import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BackupMember } from './backup-contract.js';
import type { RestoreAssetMove } from './restore-layout.js';

export interface CloneFile {
  path: string;
  source: string;
  bytes: number;
  sha256: string;
}
export interface CloneMemberContent {
  id: string;
  model?: string;
  workspace: string;
  agentDir: string;
  files: CloneFile[];
  omitted: { path: string; reason: string }[];
}
export interface CloneContentPlan {
  schemaVersion: 1;
  digest: string;
  members: CloneMemberContent[];
}
const inside = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(`${root}/`);
const hash = () => createHash('sha256');
const credentials =
  /^(?:\.env(?:\..*)?|auth(?:-profiles)?(?:\..*)?|credentials?(?:\..*)?|(?:id_rsa|id_ed25519|id_ecdsa|kubeconfig|\.npmrc|\.pypirc|\.netrc|\.dockercfg)|(?:access[-_])?tokens?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|p12|pfx|key|kdbx))$/i;
const privateState = new Set([
  '.git',
  '.aws',
  '.ssh',
  '.cache',
  '.openclaw',
  '.openclaw-aws',
  '.config',
  '.vscode',
  '.idea',
  '.mcp.json',
  '.mcp',
  'mcp.json',
  'mcpServers.json',
  'claude_desktop_config.json',
]);
const runtime =
  /^(?:node_modules|__pycache__|BOOTSTRAP\.md|openclaw\.json|.*\.(?:(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?|log))$/i;

function stagedPath(moves: RestoreAssetMove[], original: string) {
  const covering = moves
    .filter((move) => inside(move.destination, original))
    .sort((a, b) => b.destination.length - a.destination.length);
  if (!covering.length) throw new Error('Verified backup does not contain a declared workspace');
  return path.join(covering[0].source, path.relative(covering[0].destination, original));
}

/** Only workspace assets are candidates. Native databases, auth and installation
 * state are never adopted as clone identity. The caller supplies moves derived
 * from the verified native manifest, without installing those moves.
 */
export async function planCloneContent(options: {
  members: BackupMember[];
  moves: RestoreAssetMove[];
  stagingDirectory: string;
  targetHome?: string;
  signal?: AbortSignal;
}): Promise<CloneContentPlan> {
  const home = options.targetHome ?? '/home/ubuntu';
  if (!path.posix.isAbsolute(home) || path.posix.normalize(home) !== home)
    throw new Error('Clone requires a canonical target home');
  const staging = await realpath(options.stagingDirectory);
  const ids = new Set<string>();
  const members: CloneMemberContent[] = [];
  for (const member of options.members) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.id) || ids.has(member.id))
      throw new Error('Clone requires distinct valid native agent IDs');
    ids.add(member.id);
    const original = member.workspace;
    if (!path.posix.isAbsolute(original) || path.posix.normalize(original) !== original)
      throw new Error('Clone source workspace is not canonical');
    if (
      options.members.some(
        (other) =>
          other.id !== member.id &&
          (inside(original, other.workspace) || inside(other.workspace, original)),
      )
    )
      throw new Error(
        'Shared or overlapping workspaces require an explicit supported clone mapping',
      );
    if (
      inside(original, '/home/ubuntu/.openclaw') ||
      options.members.some((agent) => inside(agent.agentDir, original))
    )
      throw new Error('A native installation or agent-state root cannot be cloned as a workspace');
    const root = stagedPath(options.moves, original);
    if (!inside(staging, root)) throw new Error('Clone source escaped verified staging');
    // Refuse symlinked ancestors even when their targets happen to stay in staging.
    let current = staging;
    for (const segment of path.relative(staging, root).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Clone workspace traverses a link or non-directory');
    }
    const planned: CloneMemberContent = {
      id: member.id,
      ...(member.model ? { model: member.model } : {}),
      workspace: `${home}/.openclaw/workspaces/${member.id}`,
      agentDir: `${home}/.openclaw/agents/${member.id}/agent`,
      files: [],
      omitted: [],
    };
    const walk = async (directory: string, relative: string) => {
      for (const name of (await readdir(directory)).sort()) {
        options.signal?.throwIfAborted();
        const filename = path.join(directory, name);
        const selected = relative ? `${relative}/${name}` : name;
        const sourcePath = path.posix.join(original, selected);
        const skip = (reason: string) => planned.omitted.push({ path: selected, reason });
        if (options.members.some((agent) => inside(agent.agentDir, sourcePath))) {
          skip('native-agent-state');
          continue;
        }
        if (credentials.test(name)) {
          skip('credential-file');
          continue;
        }
        if (runtime.test(name)) {
          skip('runtime-state');
          continue;
        }
        if (privateState.has(name)) {
          skip('machine-or-integration-state');
          continue;
        }
        const entry = await lstat(filename);
        if (entry.isSymbolicLink() || (entry.nlink > 1 && entry.isFile())) {
          skip('linked-content');
          continue;
        }
        if (entry.isDirectory()) {
          await walk(filename, selected);
          continue;
        }
        if (!entry.isFile()) {
          skip('special-file');
          continue;
        }
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await file.stat();
          if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino)
            throw new Error('Clone workspace changed during inspection');
          const digest = hash();
          for await (const chunk of file.createReadStream({ autoClose: false }))
            digest.update(chunk);
          const after = await file.stat();
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error('Clone workspace changed during inspection');
          planned.files.push({
            path: selected,
            source: filename,
            bytes: before.size,
            sha256: digest.digest('hex'),
          });
        } finally {
          await file.close();
        }
      }
    };
    await walk(root, '');
    members.push(planned);
  }
  if (!members.length) throw new Error('Clone requires a complete nonempty native roster');
  return { schemaVersion: 1, digest: cloneContentDigest(members), members };
}

/** Bind content and target mapping, independently of temporary extraction paths. */
export function cloneContentDigest(members: CloneMemberContent[]): string {
  return hash()
    .update(
      JSON.stringify(
        members.map((member) => ({
          ...member,
          files: member.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        })),
      ),
    )
    .digest('hex');
}
