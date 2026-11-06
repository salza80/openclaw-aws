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
  /** Preserve only owner execution, never group/world access or special bits. */
  executable?: true;
}
export interface CloneMemberContent {
  id: string;
  model?: string;
  workspace: string;
  agentDir: string;
  files: CloneFile[];
  omitted: { path: string; reason: string }[];
  workshopSkills?: CloneSharedSkills;
}
export interface CloneSharedSkills {
  root: string;
  files: CloneFile[];
  omitted: { path: string; reason: string }[];
}
export interface CloneContentPlan {
  schemaVersion: 1;
  digest: string;
  members: CloneMemberContent[];
  sharedSkills?: CloneSharedSkills;
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

async function selectContent(
  root: string,
  original: string,
  members: BackupMember[],
  staging: string,
  credentialPaths: string[],
  signal?: AbortSignal,
  allowAgentSkillContent = false,
) {
  const selectedContent: Pick<CloneMemberContent, 'files' | 'omitted'> = { files: [], omitted: [] };
  // Refuse symlinked ancestors even when their targets happen to stay in staging.
  let current = staging;
  for (const segment of path.relative(staging, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Clone workspace traverses a link or non-directory');
  }
  const walk = async (directory: string, relative: string) => {
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted();
      const filename = path.join(directory, name);
      const selected = relative ? `${relative}/${name}` : name;
      const sourcePath = path.posix.join(original, selected);
      const skip = (reason: string) => selectedContent.omitted.push({ path: selected, reason });
      if (credentialPaths.some((credential) => inside(credential, sourcePath))) {
        skip('referenced-credential');
        continue;
      }
      if (!allowAgentSkillContent && members.some((agent) => inside(agent.agentDir, sourcePath))) {
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
        for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
        const after = await file.stat();
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error('Clone workspace changed during inspection');
        selectedContent.files.push({
          path: selected,
          source: filename,
          bytes: before.size,
          sha256: digest.digest('hex'),
          ...(before.mode & 0o100 ? { executable: true as const } : {}),
        });
      } finally {
        await file.close();
      }
    }
  };
  await walk(root, '');
  return selectedContent;
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
  /** Canonical source paths obtained from native credential-reference inspection. */
  credentialPaths: string[];
  signal?: AbortSignal;
}): Promise<CloneContentPlan> {
  const home = options.targetHome ?? '/home/ubuntu';
  if (!path.posix.isAbsolute(home) || path.posix.normalize(home) !== home)
    throw new Error('Clone requires a canonical target home');
  if (
    options.credentialPaths.some(
      (value) => !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value,
    )
  )
    throw new Error('Clone credential exclusions must use canonical source paths');
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
    const planned: CloneMemberContent = {
      id: member.id,
      ...(member.model ? { model: member.model } : {}),
      workspace: `${home}/.openclaw/workspaces/${member.id}`,
      agentDir: `${home}/.openclaw/agents/${member.id}/agent`,
      files: [],
      omitted: [],
    };
    Object.assign(
      planned,
      await selectContent(
        root,
        original,
        options.members,
        staging,
        options.credentialPaths,
        options.signal,
      ),
    );
    const originalWorkshop = path.posix.join(member.agentDir, 'workshop-skills');
    const workshop = options.moves.some((move) => inside(move.destination, originalWorkshop))
      ? stagedPath(options.moves, originalWorkshop)
      : undefined;
    if (workshop && !inside(staging, workshop))
      throw new Error('Clone skills escaped verified staging');
    let workshopPresent = !!workshop;
    try {
      if (workshop) await lstat(workshop);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      workshopPresent = false;
    }
    if (workshopPresent && workshop)
      planned.workshopSkills = {
        root: path.posix.join(planned.agentDir, 'workshop-skills'),
        ...(await selectContent(
          workshop,
          originalWorkshop,
          options.members,
          staging,
          options.credentialPaths,
          options.signal,
          true,
        )),
      };
    members.push(planned);
  }
  if (!members.length) throw new Error('Clone requires a complete nonempty native roster');
  let sharedSkills: CloneSharedSkills | undefined;
  const originalSkills = '/home/ubuntu/.openclaw/skills';
  if (options.moves.some((move) => inside(move.destination, originalSkills))) {
    const root = stagedPath(options.moves, originalSkills);
    if (!inside(staging, root)) throw new Error('Shared clone skills escaped verified staging');
    let present = true;
    try {
      await lstat(root);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      present = false;
    }
    if (present)
      sharedSkills = {
        root: `${home}/.openclaw/skills`,
        ...(await selectContent(
          root,
          originalSkills,
          options.members,
          staging,
          options.credentialPaths,
          options.signal,
        )),
      };
  }
  return {
    schemaVersion: 1,
    digest: cloneContentDigest(members, sharedSkills),
    members,
    ...(sharedSkills ? { sharedSkills } : {}),
  };
}

/** Bind content and target mapping, independently of temporary extraction paths. */
export function cloneContentDigest(
  members: CloneMemberContent[],
  sharedSkills?: CloneSharedSkills,
): string {
  const skills = (value?: CloneSharedSkills) =>
    value
      ? {
          ...value,
          files: value.files.map(({ path, bytes, sha256, executable }) => ({
            path,
            bytes,
            sha256,
            executable,
          })),
        }
      : undefined;
  return hash()
    .update(
      JSON.stringify({
        members: members.map((member) => ({
          ...member,
          workshopSkills: skills(member.workshopSkills),
          files: member.files.map(({ path, bytes, sha256, executable }) => ({
            path,
            bytes,
            sha256,
            executable,
          })),
        })),
        sharedSkills: skills(sharedSkills) ?? null,
      }),
    )
    .digest('hex');
}
