import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { BackupMember } from './backup-contract.js';
import type { RestoreSecretOwner } from './restore-secrets.js';
import { ownedRestoreRecord } from './restore-control.js';

type SessionsSdk = typeof import('openclaw/plugin-sdk/session-store-runtime');
interface HeldSession {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  alreadyPending: boolean;
  archivedAt: number;
  archiveReason: NonNullable<
    import('openclaw/plugin-sdk/session-store-runtime').SessionEntry['archiveReason']
  >;
}
interface SessionHold {
  schemaVersion: 2;
  owner: RestoreSecretOwner;
  sessions: HeldSession[];
}
function validHold(hold: SessionHold, owner: RestoreSecretOwner, members: BackupMember[]) {
  return (
    hold.schemaVersion === 2 &&
    isDeepStrictEqual(hold.owner, owner) &&
    Array.isArray(hold.sessions) &&
    hold.sessions.every(
      (session) =>
        members.some(
          (member) =>
            member.id === session.agentId &&
            path.join(member.agentDir, 'openclaw-agent.sqlite') === session.storePath,
        ) &&
        typeof session.sessionKey === 'string' &&
        session.sessionKey.length > 0 &&
        typeof session.sessionId === 'string' &&
        session.sessionId.length > 0 &&
        typeof session.alreadyPending === 'boolean' &&
        Number.isSafeInteger(session.archivedAt) &&
        session.archivedAt > 0 &&
        [
          'active-session-cap',
          'age-retention',
          'manual',
          'restart-recovery',
          'stale-dashboard',
        ].includes(session.archiveReason),
    ) &&
    new Set(
      hold.sessions.map((session) =>
        JSON.stringify([session.agentId, session.storePath, session.sessionKey]),
      ),
    ).size === hold.sessions.length
  );
}

/** Native archived state prevents automatic recovery while retaining history.
 * Operators can explicitly restore selected conversations through native UI/API.
 * Existing incomplete initialization flags are never cleared.
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
    if (!validHold(hold, options.owner, options.members))
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
          archivedAt: entry.archivedAt ?? Date.now(),
          archiveReason: entry.archiveReason ?? 'manual',
        });
    }
    hold = { schemaVersion: 2, owner: options.owner, sessions };
    await ownedRestoreRecord(options.journal, hold);
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
        return { archivedAt: session.archivedAt, archiveReason: session.archiveReason };
      },
    });
    if (
      entry?.sessionId !== session.sessionId ||
      entry.archivedAt !== session.archivedAt ||
      (session.alreadyPending && entry.initializationPending !== true)
    )
      throw new Error('Native session adoption hold was not established');
  }
  await options.assertInactive();
  return {
    held: hold.sessions.length,
    preexistingIncomplete: hold.sessions.filter((session) => session.alreadyPending).length,
  };
}

/** Read-only check used before and after service activation. It never releases work. */
export async function inspectRestoredSessionHolds(options: {
  owner: RestoreSecretOwner;
  members: BackupMember[];
  nativePackageJson: string;
  journal: string;
}) {
  const stat = await lstat(options.journal);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    stat.size > 8 * 1024 * 1024
  )
    throw new Error('Restored session hold journal is unsafe');
  const hold = JSON.parse(await readFile(options.journal, 'utf8')) as SessionHold;
  if (!validHold(hold, options.owner, options.members))
    throw new Error('Restored session hold ownership differs');
  const require = createRequire(options.nativePackageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href
  )) as SessionsSdk;
  let count = 0;
  for (const member of options.members) {
    const storePath = path.join(member.agentDir, 'openclaw-agent.sqlite');
    const expected = hold.sessions.filter(
      (session) => session.agentId === member.id && session.storePath === storePath,
    );
    const actual = await sdk.listSessionEntriesAsync({
      agentId: member.id,
      storePath,
      readConsistency: 'latest',
    });
    if (
      expected.length !== actual.length ||
      actual.some(
        ({ sessionKey, entry }) =>
          !expected.some(
            (saved) =>
              saved.sessionKey === sessionKey &&
              saved.sessionId === entry.sessionId &&
              saved.archivedAt === entry.archivedAt &&
              (!saved.alreadyPending || entry.initializationPending === true),
          ),
      )
    )
      throw new Error('Restored session adoption holds or generations changed');
    count += actual.length;
  }
  if (count !== hold.sessions.length)
    throw new Error('Session hold inventory includes another member or store');
  return { held: count };
}
