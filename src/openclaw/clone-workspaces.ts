import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { link, lstat, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cloneContentDigest, type CloneContentPlan } from './clone-content.js';
import { assertDirectoryChain } from './restore-layout.js';
import { ownedRestoreRecord, privateRestoreJson } from './restore-control.js';
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Populate fresh workspaces, never installation/agent databases. The host
 * operation lock and inactive Gateway surround this step and native agents add.
 */
export async function installCloneWorkspaces(options: {
  operationId: string;
  plan: CloneContentPlan;
  journal: string;
  home?: string;
  signal?: AbortSignal;
}) {
  const { operationId, plan } = options;
  const home = options.home ?? '/home/ubuntu';
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId) ||
    !/^[a-f0-9]{64}$/.test(plan.digest) ||
    !plan.members.length ||
    cloneContentDigest(plan.members) !== plan.digest ||
    new Set(plan.members.map((member) => member.id)).size !== plan.members.length ||
    !path.isAbsolute(home) ||
    path.normalize(home) !== home
  )
    throw new Error('Invalid clone content operation');
  for (const member of plan.members) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.id) ||
      member.workspace !== `${home}/.openclaw/workspaces/${member.id}`
    )
      throw new Error('Clone workspace mapping escaped the fresh target');
    for (const file of member.files)
      if (
        path.posix.isAbsolute(file.path) ||
        path.posix.normalize(file.path) !== file.path ||
        ['.', '..'].includes(file.path) ||
        file.path.startsWith('../') ||
        file.path.includes('\0') ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0
      )
        throw new Error('Invalid clone workspace file');
  }
  await assertDirectoryChain(path.dirname(options.journal), home, false);
  const expected = {
    schemaVersion: 1,
    operationId,
    digest: plan.digest,
    workspaces: plan.members.map((member) => member.workspace),
  };
  try {
    if (!isDeepStrictEqual(await privateRestoreJson(options.journal), expected))
      throw new Error('Clone workspace journal belongs to another operation');
  } catch (error) {
    if (!missing(error)) throw error;
    for (const member of plan.members) {
      try {
        await lstat(member.workspace);
        throw new Error('Clone target workspace already exists', { cause: error });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    await ownedRestoreRecord(options.journal, expected);
  }
  let files = 0;
  for (const member of plan.members) {
    await assertDirectoryChain(member.workspace, home, true);
    for (const item of member.files) {
      options.signal?.throwIfAborted();
      const destination = path.join(member.workspace, item.path);
      await assertDirectoryChain(path.dirname(destination), home, true);
      const incoming = path.join(path.dirname(options.journal), `workspace-${item.sha256}.part`);
      try {
        const existing = await lstat(destination);
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.uid !== process.getuid?.() ||
          existing.mode & 0o077 ||
          existing.nlink > 2
        )
          throw new Error('Clone destination has foreign or linked content');
        const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const digest = createHash('sha256');
          for await (const chunk of file.createReadStream({ autoClose: false }))
            digest.update(chunk);
          if (existing.size !== item.bytes || digest.digest('hex') !== item.sha256)
            throw new Error('Clone workspace content changed; nothing was overwritten');
        } finally {
          await file.close();
        }
        if (existing.nlink === 2) {
          const retained = await lstat(incoming).catch(() => {
            throw new Error('Clone destination has an unrelated hard link');
          });
          if (
            !retained.isFile() ||
            retained.isSymbolicLink() ||
            retained.dev !== existing.dev ||
            retained.ino !== existing.ino
          )
            throw new Error('Clone destination has an unrelated hard link');
          await rm(incoming);
        }
        files++;
        continue;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      try {
        const old = await lstat(incoming);
        if (
          !old.isFile() ||
          old.isSymbolicLink() ||
          old.uid !== process.getuid?.() ||
          old.mode & 0o077 ||
          old.nlink !== 1
        )
          throw new Error('Clone incoming file is unsafe');
        await rm(incoming);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      try {
        const input = await open(item.source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const original = await input.stat();
          if (!original.isFile() || original.nlink !== 1 || original.size !== item.bytes)
            throw new Error('Selected clone source changed');
          const output = await open(incoming, 'wx', 0o600);
          try {
            const digest = createHash('sha256');
            let copied = 0;
            for await (const chunk of input.createReadStream({ autoClose: false })) {
              options.signal?.throwIfAborted();
              digest.update(chunk);
              copied += chunk.length;
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw new Error('Clone file write made no progress');
                offset += bytesWritten;
              }
            }
            if (copied !== item.bytes || digest.digest('hex') !== item.sha256)
              throw new Error('Selected clone content differs from the reviewed backup');
            await output.sync();
          } finally {
            await output.close();
          }
        } finally {
          await input.close();
        }
        // A hard link publishes without overwriting a destination that appeared
        // while copying. Remove the private incoming link immediately afterward.
        await link(incoming, destination);
        await rm(incoming);
        const directory = await open(path.dirname(destination), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        files++;
      } finally {
        await rm(incoming, { force: true });
      }
    }
  }
  return { members: plan.members.length, files };
}
