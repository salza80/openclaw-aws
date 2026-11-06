import path from 'node:path';
import { lstat, open, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createPrivateControlRecord, privateModelJson } from './model-journal.js';
import { assertDirectoryChain } from './restore-layout.js';
import { parseTeamJob, teamJobDigest, type TeamJob } from './team-contract.js';
import { teamNativeId } from './team-definition.js';

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
export async function teamHostJournal(home: string, input: TeamJob, create: boolean) {
  const job = parseTeamJob(input);
  if (job.action.kind !== 'configure')
    throw new Error('Read-only team preview has no mutation journal');
  const root = path.join(home, '.openclaw-aws');
  const directory = path.join(root, 'team-operations', job.operationId);
  await assertDirectoryChain(directory, home, create);
  for (const name of [root, path.join(root, 'team-operations'), directory])
    if ((await lstat(name)).mode & 0o077)
      throw new Error('Team journals require private directories');
  const filename = path.join(directory, 'request.json');
  if (create) {
    try {
      await createPrivateControlRecord(filename, job);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  if (!isDeepStrictEqual(await privateModelJson(filename), job))
    throw new Error('Team operation ID belongs to a different immutable request');
  const owner = {
    schemaVersion: 1,
    kind: 'team',
    operationId: job.operationId,
    teamId: job.teamId,
    stackId: job.target.stackId,
    roleId: job.target.roleId,
    requestDigest: teamJobDigest(job),
  };
  const names = new Set([
    'started',
    'configuration-intent',
    'configuration-acknowledged',
    'complete',
    'aborted',
    ...job.definition.members.map(
      (member) => 'instruction-' + teamNativeId(job.definition, member.id),
    ),
  ]);
  const maintenance = path.join(root, 'maintenance.json');
  const read = async (name: string) => {
    if (!names.has(name)) throw new Error('Unsupported team journal transition');
    try {
      const value = await privateModelJson(path.join(directory, name + '.json'));
      for (const [key, expected] of Object.entries(owner))
        if (value[key] !== expected) throw new Error('Team transition ownership changed');
      return value;
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  };
  const ownsMaintenance = async () => {
    try {
      return isDeepStrictEqual(await privateModelJson(maintenance), owner);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  };
  return {
    read,
    ownsMaintenance,
    async claim() {
      try {
        await createPrivateControlRecord(maintenance, owner);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'EEXIST' ||
          !(await ownsMaintenance())
        )
          throw new Error(
            'Another maintenance operation owns this host; inspect it before team setup',
            { cause: error },
          );
      }
    },
    async mark(name: string, fields: { configHash?: string } = {}) {
      if (!(await ownsMaintenance())) throw new Error('Team maintenance ownership changed');
      if (!names.has(name)) throw new Error('Unsupported team journal transition');
      const value = { ...owner, ...fields };
      try {
        await createPrivateControlRecord(path.join(directory, name + '.json'), value);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'EEXIST' ||
          !isDeepStrictEqual(await read(name), value)
        )
          throw error;
      }
    },
    async release() {
      if (!(await ownsMaintenance()) || !((await read('complete')) || (await read('aborted'))))
        throw new Error('Unresolved team maintenance cannot be released');
      await unlink(maintenance);
      const file = await open(root, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    },
  };
}

/** This is a stable host ownership receipt, not a second native agent roster. */
export async function teamHostOwnership(home: string, job: TeamJob, claim: boolean) {
  const root = path.join(home, '.openclaw-aws');
  try {
    await assertDirectoryChain(root, home, claim);
  } catch (error) {
    if (!claim && missing(error)) return false;
    throw error;
  }
  if ((await lstat(root)).mode & 0o077) throw new Error('Team ownership directory must be private');
  const filename = path.join(root, 'team-owner.json');
  const owner = { schemaVersion: 1, teamId: job.teamId, target: job.target };
  if (claim) {
    try {
      await createPrivateControlRecord(filename, owner);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  try {
    if (!isDeepStrictEqual(await privateModelJson(filename), owner))
      throw new Error('A different team owns this hosting deployment');
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
