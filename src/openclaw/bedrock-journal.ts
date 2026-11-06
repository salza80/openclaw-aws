import { lstat, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBedrockJob, bedrockJobDigest, type BedrockJob } from './bedrock-contract.js';
import { createPrivateControlRecord, privateModelJson } from './model-journal.js';
import { assertDirectoryChain } from './restore-layout.js';

export type BedrockPhase =
  | 'started'
  | 'plugin-intent'
  | 'plugin-ready'
  | 'environment-intent'
  | 'environment-ready'
  | 'config-intent'
  | 'config-acknowledged'
  | 'config-complete'
  | 'config-rolled-back'
  | 'config-uncertain'
  | 'discovery-intent'
  | 'complete'
  | 'rolled-back'
  | 'unchanged'
  | 'uncertain';
export interface BedrockEvent {
  phase: BedrockPhase;
  checkedAt: string;
  beforeHash?: string;
}
const transitions: Record<BedrockPhase | 'none', BedrockPhase[]> = {
  none: ['started', 'unchanged', 'complete'],
  started: ['plugin-intent', 'unchanged', 'uncertain'],
  'plugin-intent': ['plugin-ready', 'uncertain'],
  'plugin-ready': ['environment-intent', 'uncertain'],
  'environment-intent': ['environment-ready', 'uncertain'],
  'environment-ready': ['config-intent', 'uncertain'],
  'config-intent': ['config-acknowledged', 'config-uncertain', 'uncertain'],
  'config-acknowledged': [
    'discovery-intent',
    'config-complete',
    'config-rolled-back',
    'config-uncertain',
    'uncertain',
  ],
  'config-complete': [
    'discovery-intent',
    'config-rolled-back',
    'config-uncertain',
    'uncertain',
    'complete',
  ],
  'config-rolled-back': ['rolled-back', 'uncertain'],
  'config-uncertain': ['uncertain'],
  'discovery-intent': [
    'config-complete',
    'config-rolled-back',
    'config-uncertain',
    'complete',
    'uncertain',
  ],
  uncertain: ['complete'],
  complete: [],
  'rolled-back': [],
  unchanged: [],
};
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function sync(directory: string) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function bedrockHostJournal(home: string, input: BedrockJob, create: boolean) {
  const job = parseBedrockJob(input);
  const root = path.join(home, '.openclaw-aws');
  const directory = path.join(root, 'bedrock', job.operationId);
  if (!path.isAbsolute(home) || path.resolve(home) !== home || home === '/')
    throw new Error('Invalid Bedrock journal home');
  await assertDirectoryChain(directory, home, create);
  for (const value of [root, path.join(root, 'bedrock'), directory])
    if ((await lstat(value)).mode & 0o077) throw new Error('Bedrock journals must be private');
  const filename = path.join(directory, 'request.json');
  if (create) {
    try {
      await createPrivateControlRecord(filename, job);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  if (!isDeepStrictEqual(parseBedrockJob(await privateModelJson(filename)), job))
    throw new Error('Bedrock operation ID belongs to a different immutable request');
  const owner = {
    schemaVersion: 1,
    kind: 'bedrock-connection',
    operationId: job.operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    roleId: job.target.roleId,
    digest: bedrockJobDigest(job),
  };
  const maintenance = path.join(root, 'maintenance.json');
  const parseEvent = (value: Record<string, unknown>): BedrockEvent => {
    if (
      Object.keys(value).some((key) => !['phase', 'checkedAt', 'beforeHash'].includes(key)) ||
      typeof value.phase !== 'string' ||
      !Object.hasOwn(transitions, value.phase) ||
      value.phase === 'none' ||
      typeof value.checkedAt !== 'string' ||
      value.checkedAt.length > 64 ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      value.phase.startsWith('config-') !== (value.beforeHash !== undefined) ||
      (value.beforeHash !== undefined &&
        (typeof value.beforeHash !== 'string' ||
          !value.beforeHash ||
          value.beforeHash.length > 2048 ||
          /[\r\n\0]/.test(value.beforeHash)))
    )
      throw new Error('Invalid Bedrock journal event');
    return value as unknown as BedrockEvent;
  };
  const events = async () => {
    const names = (await readdir(directory)).filter((name) => name !== 'request.json').sort();
    if (
      names.length > 32 ||
      names.some((name, index) => name !== `event-${String(index).padStart(4, '0')}.json`)
    )
      throw new Error('Bedrock journal is incomplete or oversized');
    const records = await Promise.all(
      names.map(async (name) => parseEvent(await privateModelJson(path.join(directory, name)))),
    );
    let previous: BedrockPhase | 'none' = 'none';
    let configurationHash: string | undefined;
    for (const row of records) {
      if (!transitions[previous].includes(row.phase))
        throw new Error('Invalid Bedrock journal transition');
      previous = row.phase;
      if (row.beforeHash !== undefined) {
        configurationHash ??= row.beforeHash;
        if (configurationHash !== row.beforeHash)
          throw new Error('Bedrock configuration intent identity changed');
      }
    }
    return records;
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
    events,
    ownsMaintenance,
    async claim() {
      if ((await events()).length)
        throw new Error('Bedrock operation already started; inspect it without replaying');
      try {
        await createPrivateControlRecord(maintenance, owner);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new Error(
            'Another maintenance operation owns this host; inspect it instead of stealing its hold',
            { cause: error },
          );
        throw error;
      }
    },
    async append(event: Omit<BedrockEvent, 'checkedAt'>) {
      if (!(await ownsMaintenance())) throw new Error('Bedrock maintenance ownership changed');
      const history = await events();
      const next = parseEvent({ ...event, checkedAt: new Date().toISOString() });
      const previousConfiguration = history.find((row) => row.beforeHash !== undefined)?.beforeHash;
      if (
        next.beforeHash !== undefined &&
        previousConfiguration !== undefined &&
        next.beforeHash !== previousConfiguration
      )
        throw new Error('Bedrock configuration intent identity changed');
      if (
        history.length >= 32 ||
        !transitions[history.at(-1)?.phase ?? 'none'].includes(next.phase)
      )
        throw new Error('Invalid Bedrock journal transition');
      await createPrivateControlRecord(
        path.join(directory, `event-${String(history.length).padStart(4, '0')}.json`),
        next,
      );
    },
    async release() {
      if (
        !(await ownsMaintenance()) ||
        !['complete', 'rolled-back', 'unchanged'].includes((await events()).at(-1)?.phase ?? '')
      )
        throw new Error('Unresolved Bedrock maintenance cannot be released');
      await unlink(maintenance);
      await sync(root);
    },
  };
}
