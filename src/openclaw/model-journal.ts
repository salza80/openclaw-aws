import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertDirectoryChain } from './restore-layout.js';
import {
  modelJobDigest,
  modelObject,
  modelText,
  parseModelJob,
  type ModelJob,
} from './model-contract.js';
import {
  nativeModelReference,
  nativeModelScope,
  nativeModelSetting,
  type ModelMutationRecord,
} from './model-control.js';

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function syncDirectory(directory: string) {
  const file = await open(directory, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Only bounded, unlinked-to-other-files, private regular files are control data.
 * NONBLOCK makes a substituted FIFO fail inspection instead of hanging a job. */
export async function privateModelJson(filename: string): Promise<Record<string, unknown>> {
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.nlink !== 1 ||
      stat.size > 128 * 1024
    )
      throw new Error('Model operation file is unsafe');
    return modelObject(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}
async function createJson(filename: string, value: object) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 128 * 1024)
    throw new Error('Model operation record exceeds its bound');
  const file = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(serialized);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(path.dirname(filename));
}
/** Request delivery is performed only as the native service user. This tree is
 * separate from the append-only mutation journal and contains no credentials. */
export async function installModelRequest(home: string, input: unknown) {
  const job = parseModelJob(input);
  if (!path.isAbsolute(home) || path.resolve(home) !== home || home === '/')
    throw new Error('Invalid model request home');
  const root = path.join(home, '.openclaw-aws');
  const directory = path.join(root, 'model-requests', job.operationId);
  await assertDirectoryChain(directory, home, true);
  for (const value of [root, path.join(root, 'model-requests'), directory]) {
    if ((await lstat(value)).mode & 0o077)
      throw new Error('Model delivery directories must be private');
  }
  const filename = path.join(directory, 'request.json');
  try {
    await createJson(filename, job);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!isDeepStrictEqual(parseModelJob(await privateModelJson(filename)), job))
      throw new Error('Delivered model operation ID belongs to another request', { cause: error });
  }
  return filename;
}
export type ModelHostEvent =
  | { phase: 'started' | 'unchanged'; checkedAt: string }
  | (ModelMutationRecord & { checkedAt: string });
function event(value: unknown): ModelHostEvent {
  const row = modelObject(value);
  const checkedAt = modelText(row.checkedAt, 64);
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid model journal timestamp');
  if (['started', 'unchanged'].includes(String(row.phase))) {
    if (Object.keys(row).some((key) => !['phase', 'checkedAt'].includes(key)))
      throw new Error('Invalid model journal event');
    return { phase: row.phase as 'started' | 'unchanged', checkedAt };
  }
  if (
    !['intent', 'acknowledged', 'complete', 'rolled-back', 'uncertain'].includes(
      String(row.phase),
    ) ||
    Object.keys(row).some(
      (key) =>
        ![
          'phase',
          'scope',
          'beforeHash',
          'requested',
          'previous',
          'previousPublished',
          'checkedAt',
        ].includes(key),
    )
  )
    throw new Error('Invalid model mutation record');
  return {
    phase: row.phase as ModelMutationRecord['phase'],
    scope: nativeModelScope(modelObject(row.scope) as unknown as ModelMutationRecord['scope']),
    beforeHash: modelText(row.beforeHash),
    requested: nativeModelReference(row.requested),
    previous: row.previous === null ? null : (nativeModelSetting(row.previous) ?? null),
    previousPublished: nativeModelReference(row.previousPublished),
    checkedAt,
  };
}
/** The caller holds the shared host flock for this journal's entire lifetime.
 * Immutable request and append-only records survive client loss. Maintenance is
 * shared with backup/recovery, and is never adopted or cleared merely by age. */
export async function modelHostJournal(home: string, input: ModelJob, create: boolean) {
  const job = parseModelJob(input);
  if (job.action.kind !== 'set') throw new Error('Only model mutations own a host journal');
  if (!path.isAbsolute(home) || path.resolve(home) !== home || home === '/')
    throw new Error('Invalid model journal home');
  const root = path.join(home, '.openclaw-aws');
  const work = path.join(root, 'models', job.operationId);
  await assertDirectoryChain(work, home, create);
  for (const directory of [root, path.join(root, 'models'), work]) {
    const stat = await lstat(directory);
    if (stat.mode & 0o077) throw new Error('Model journal directories must be private');
  }
  const request = path.join(work, 'request.json');
  if (create) {
    try {
      await createJson(request, job);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (!isDeepStrictEqual(parseModelJob(await privateModelJson(request)), job))
        throw new Error('Model operation ID belongs to another request', { cause: error });
    }
  } else if (!isDeepStrictEqual(parseModelJob(await privateModelJson(request)), job))
    throw new Error('Model operation ID belongs to another request');
  const digest = modelJobDigest(job);
  const owner = {
    schemaVersion: 1,
    kind: 'model-selection',
    operationId: job.operationId,
    stackId: job.target.stackId,
    roleId: job.target.roleId,
    instanceId: job.target.instanceId,
    digest,
  };
  const maintenance = path.join(root, 'maintenance.json');
  const validateHistory = (entries: ModelHostEvent[]) => {
    const transitions: Record<string, string[]> = {
      none: ['started', 'unchanged'],
      started: ['intent', 'unchanged'],
      unchanged: [],
      intent: ['acknowledged', 'uncertain', 'complete', 'rolled-back'],
      acknowledged: ['complete', 'rolled-back', 'uncertain'],
      complete: ['rolled-back', 'uncertain'],
      'rolled-back': ['complete', 'uncertain'],
      uncertain: ['complete', 'rolled-back'],
    };
    let previous = 'none';
    for (const value of entries) {
      if (!transitions[previous].includes(value.phase))
        throw new Error('Invalid model journal transition');
      previous = value.phase;
      if (
        'scope' in value &&
        (!isDeepStrictEqual(value.scope, job.scope) ||
          job.action.kind !== 'set' ||
          value.requested !== job.action.model ||
          value.beforeHash !== job.action.expectedHash)
      )
        throw new Error('Model journal does not match its immutable request');
    }
    const mutations = entries.filter(
      (value): value is ModelMutationRecord & { checkedAt: string } => 'scope' in value,
    );
    if (
      mutations.some(
        (value) =>
          !isDeepStrictEqual(
            { ...value, phase: 'intent', checkedAt: '' },
            { ...mutations[0], phase: 'intent', checkedAt: '' },
          ),
      )
    )
      throw new Error('Model journal mutation identity changed');
  };
  const events = async () => {
    const names = (await readdir(work)).filter((name) => name !== 'request.json').sort();
    if (
      names.length > 16 ||
      names.some((name, index) => name !== `event-${String(index).padStart(4, '0')}.json`)
    )
      throw new Error('Model journal is incomplete or contains unsupported records');
    const entries = await Promise.all(
      names.map(async (name) => event(await privateModelJson(path.join(work, name)))),
    );
    validateHistory(entries);
    return entries;
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
        throw new Error('Model operation has already started; inspect/reconcile it without replay');
      try {
        await createJson(maintenance, owner);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new Error(
            'A maintenance operation owns this host; inspect it instead of clearing it by age',
            { cause: error },
          );
        throw error;
      }
    },
    async append(value: Omit<ModelHostEvent, 'checkedAt'> | ModelMutationRecord) {
      if (!(await ownsMaintenance())) throw new Error('Model maintenance ownership changed');
      const entries = await events();
      if (entries.length >= 16) throw new Error('Model journal exceeds its operation bound');
      const next = event({ ...value, checkedAt: new Date().toISOString() });
      validateHistory([...entries, next]);
      await createJson(
        path.join(work, `event-${String(entries.length).padStart(4, '0')}.json`),
        next,
      );
    },
    async release() {
      if (!(await ownsMaintenance())) throw new Error('Model maintenance ownership changed');
      const phase = (await events()).at(-1)?.phase;
      if (!phase || !['complete', 'rolled-back', 'unchanged'].includes(phase))
        throw new Error('Unresolved model maintenance cannot be released');
      await unlink(maintenance);
      await syncDirectory(root);
    },
  };
}
