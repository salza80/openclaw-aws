import { constants } from 'node:fs';
import { lstat, open, readdir, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertDirectoryChain } from './restore-layout.js';
import type { BackupMember } from './backup-contract.js';
import { assertTeamLayout, teamNativeId, type TeamDefinition } from './team-definition.js';
import { teamInstructions } from './team-configuration.js';
import { teamId, type TeamInstructionPin } from './team-contract.js';

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function instructionHash(filename: string, home: string, links = 1) {
  let file;
  try {
    await assertDirectoryChain(path.dirname(filename), home, false);
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022 ||
      stat.nlink < 1 ||
      stat.nlink > links ||
      stat.size > 65536
    )
      throw new Error('Team role instructions have unsupported ownership or size');
    return hash(await file.readFile());
  } finally {
    await file.close();
  }
}
async function emptyRoot(directory: string, home: string, allowed: string[] = []) {
  try {
    await assertDirectoryChain(directory, home, false);
    if ((await readdir(directory)).some((name) => !allowed.includes(name)))
      throw new Error('New team role would adopt unrelated workspace or agent state');
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
export async function inspectTeamInstructions(
  home: string,
  definition: TeamDefinition,
  members: BackupMember[],
  existing: string[],
): Promise<TeamInstructionPin[]> {
  members = assertTeamLayout(definition, home, members);
  const result: TeamInstructionPin[] = [];
  for (const member of members) {
    if (!existing.includes(member.id)) {
      await emptyRoot(member.workspace, home);
      await emptyRoot(member.agentDir, home);
    } else {
      await assertDirectoryChain(member.workspace, home, false);
      await assertDirectoryChain(member.agentDir, home, false);
    }
    result.push({
      agentId: member.id,
      sha256: await instructionHash(path.join(member.workspace, 'AGENTS.md'), home),
    });
  }
  return result.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}
async function sync(directory: string) {
  const file = await open(directory, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** The host flock/maintenance owns local writes. A resume adopts only exact
 * desired bytes or retries a local write whose approved preimage is unchanged.
 * Native config RPCs use a separate no-replay intent boundary. */
export async function writeTeamInstructions(options: {
  home: string;
  operationId: string;
  definition: TeamDefinition;
  members: BackupMember[];
  existing: string[];
  pins: TeamInstructionPin[];
  /** True only when a durable intent for this exact staging name preexists. */
  beforeWrite(agentId: string): Promise<void | boolean>;
}) {
  const operationId = teamId(options.operationId);
  for (const member of assertTeamLayout(options.definition, options.home, options.members)) {
    const logical = options.definition.members.find(
      (value) => teamNativeId(options.definition, value.id) === member.id,
    );
    const pin = options.pins.find((value) => value.agentId === member.id);
    if (!logical || !pin) throw new Error('Team instructions are missing approved member coverage');
    const body = teamInstructions(options.definition, logical.id);
    const desired = hash(body);
    const filename = path.join(member.workspace, 'AGENTS.md');
    const incoming = path.join(member.workspace, `.AGENTS.md.openclaw-team-${operationId}`);
    if (!options.existing.includes(member.id)) {
      await emptyRoot(member.workspace, options.home, ['AGENTS.md', path.basename(incoming)]);
      await emptyRoot(member.agentDir, options.home);
    }
    // Recover the one intermediate two-link state of create-only publication.
    // No foreign name is removed: both regular files must be this exact inode
    // and contain the approved role bytes.
    try {
      await assertDirectoryChain(member.workspace, options.home, false);
      const [current, staged] = await Promise.all([lstat(filename), lstat(incoming)]);
      if (
        current.isFile() &&
        staged.isFile() &&
        current.nlink === 2 &&
        staged.nlink === 2 &&
        current.dev === staged.dev &&
        current.ino === staged.ino &&
        (await instructionHash(filename, options.home, 2)) === desired
      ) {
        await unlink(incoming);
        await sync(member.workspace);
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if ((await instructionHash(filename, options.home)) === desired) continue;
    if ((await instructionHash(filename, options.home)) !== pin.sha256)
      throw new Error('Team role instructions changed after preview; nothing was overwritten');
    const resumingOwnedStage = (await options.beforeWrite(member.id)) === true;
    await assertDirectoryChain(member.workspace, options.home, true);
    await assertDirectoryChain(member.agentDir, options.home, true);
    let file;
    try {
      file = await open(
        incoming,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if ((await instructionHash(incoming, options.home)) !== desired) {
        if (!resumingOwnedStage) throw error;
        file = await open(
          incoming,
          constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            stat.mode & 0o077 ||
            stat.nlink !== 1 ||
            stat.size > 65536
          )
            throw new Error('Unowned team staging file was retained', { cause: error });
          await file.truncate(0);
        } catch (stagingError) {
          await file.close();
          throw stagingError;
        }
      }
    }
    if (file) {
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await assertDirectoryChain(member.workspace, options.home, false);
    if ((await instructionHash(filename, options.home)) !== pin.sha256)
      throw new Error('Team role instructions changed before publication; original was retained');
    if (pin.sha256 === null) {
      await link(incoming, filename);
      await unlink(incoming);
    } else await rename(incoming, filename);
    await sync(member.workspace);
    if ((await instructionHash(filename, options.home)) !== desired)
      throw new Error('Team role instruction publication is unconfirmed');
  }
}
export async function assertTeamInstructions(
  home: string,
  definition: TeamDefinition,
  members: BackupMember[],
) {
  for (const member of assertTeamLayout(definition, home, members)) {
    const logical = definition.members.find(
      (value) => teamNativeId(definition, value.id) === member.id,
    );
    if (
      !logical ||
      (await instructionHash(path.join(member.workspace, 'AGENTS.md'), home)) !==
        hash(teamInstructions(definition, logical.id))
    )
      throw new Error('Team role instructions differ from the approved definition');
    await assertDirectoryChain(member.agentDir, home, false);
    const stat = await lstat(member.agentDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error('Team native agent state ownership is unconfirmed');
  }
}
