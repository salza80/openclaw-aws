import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { BackupMember } from './backup-contract.js';
import type { RestoreSecretOwner } from './restore-secrets.js';

type SessionsSdk = typeof import('openclaw/plugin-sdk/session-store-runtime');
interface HeldSession {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  alreadyPending: boolean;
}
interface SessionHold {
  schemaVersion: 1;
  owner: RestoreSecretOwner;
  sessions: HeldSession[];
}

/** Session adoption on a fresh machine is incomplete until reviewed. Native
 * initializationPending blocks work admission without editing database internals,
 * deleting transcripts or replacing native recovery records.
 */
export async function holdRestoredSessions(options: {
  owner: RestoreSecretOwner;
  members: BackupMember[];
  nativePackageJson: string;
  journal: string;
  assertInactive: () => Promise<void>;
}) {
  const require = createRequire(options.nativePackageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href
  )) as SessionsSdk;
  await options.assertInactive();
  await mkdir(path.dirname(options.journal), { recursive: true, mode: 0o700 });
  const directory = await lstat(path.dirname(options.journal));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.mode & 0o077 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error('Restored session hold directory is not private');
  let hold: SessionHold | undefined;
  try {
    const stat = await lstat(options.journal);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 8 * 1024 * 1024
    )
      throw new Error('Restored session hold journal is unsafe');
    hold = JSON.parse(await readFile(options.journal, 'utf8')) as SessionHold;
    if (
      hold.schemaVersion !== 1 ||
      !isDeepStrictEqual(hold.owner, options.owner) ||
      !Array.isArray(hold.sessions)
    )
      throw new Error('Another operation owns the restored session hold');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (!hold) {
    const sessions: HeldSession[] = [];
    for (const member of options.members) {
      const storePath = path.join(member.agentDir, 'openclaw-agent.sqlite');
      // Read-only public enumeration does not create a missing agent database.
      const entries = await sdk.listSessionEntriesAsync({
        agentId: member.id,
        storePath,
        readConsistency: 'latest',
      });
      for (const { sessionKey, entry } of entries)
        sessions.push({
          agentId: member.id,
          storePath,
          sessionKey,
          sessionId: entry.sessionId,
          alreadyPending: entry.initializationPending === true,
        });
    }
    hold = { schemaVersion: 1, owner: options.owner, sessions };
    await writeFile(options.journal, JSON.stringify(hold), { flag: 'wx', mode: 0o600 });
  }
  const expected = JSON.stringify(hold);
  const assertCurrent = () => {
    if (readFileSync(options.journal, 'utf8') !== expected)
      throw new Error('Restore session hold ownership changed');
  };
  for (const session of hold.sessions) {
    await options.assertInactive();
    const entry = await sdk.prepareSessionEntryPatch({
      agentId: session.agentId,
      storePath: session.storePath,
      sessionKey: session.sessionKey,
      authority: { kind: 'host', assertCurrent },
      requireWriteSuccess: true,
      preserveActivity: true,
      skipMaintenance: true,
      prepare(current) {
        if (current.sessionId !== session.sessionId)
          throw new Error('Restored session generation changed before adoption');
        return { initializationPending: true };
      },
    });
    if (entry?.sessionId !== session.sessionId || entry.initializationPending !== true)
      throw new Error('Native session adoption hold was not established');
  }
  await options.assertInactive();
  return {
    held: hold.sessions.length,
    preexistingIncomplete: hold.sessions.filter((session) => session.alreadyPending).length,
  };
}
