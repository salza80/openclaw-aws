import { createHash } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getConfigRoot } from '../cli/utils/config.js';
import {
  parseModelHostTarget,
  modelText,
  type ModelHostTarget,
} from '../openclaw/model-contract.js';
import { privateModelJson, createPrivateControlRecord } from '../openclaw/model-journal.js';
import { assertDirectoryChain } from '../openclaw/restore-layout.js';
export interface ControlFence {
  schemaVersion: 1;
  operationId: string;
  requestDigest: string;
  artifactDigest: string;
  kind?: 'bedrock-connection';
}
export function controlFencePath(target: ModelHostTarget) {
  const digest = createHash('sha256')
    .update(JSON.stringify(parseModelHostTarget(target)))
    .digest('hex');
  // Model and provider changes share one host fence, rather than racing
  // separate local lock trees.
  return path.join(getConfigRoot(), 'model-pending', `${digest}.json`);
}
export async function readControlFence(target: ModelHostTarget): Promise<ControlFence | undefined> {
  const filename = controlFencePath(target);
  try {
    await assertDirectoryChain(path.dirname(filename), getConfigRoot(), false);
    const row = await privateModelJson(filename);
    if (
      Object.keys(row).some(
        (key) =>
          !['schemaVersion', 'operationId', 'requestDigest', 'artifactDigest', 'kind'].includes(
            key,
          ),
      ) ||
      row.schemaVersion !== 1 ||
      typeof row.operationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.operationId) ||
      !/^[a-f0-9]{64}$/.test(modelText(row.requestDigest, 64)) ||
      !/^[a-f0-9]{64}$/.test(modelText(row.artifactDigest, 64)) ||
      (row.kind !== undefined && row.kind !== 'bedrock-connection')
    )
      throw new Error('Invalid pending native-control ownership');
    return row as unknown as ControlFence;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function writeControlRecord(filename: string, value: object, adopt = false) {
  await assertDirectoryChain(path.dirname(filename), getConfigRoot(), true);
  const root = path.resolve(getConfigRoot());
  for (
    let directory = path.resolve(path.dirname(filename));
    directory !== root;
    directory = path.dirname(directory)
  ) {
    if (directory === path.dirname(directory))
      throw new Error('Native-control record escaped its private root');
    if ((await lstat(directory)).mode & 0o077)
      throw new Error('Native-control operation directories must be private');
  }
  try {
    await createPrivateControlRecord(filename, value);
  } catch (error) {
    if (!adopt || !(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
      throw error;
    if (!isDeepStrictEqual(await privateModelJson(filename), value))
      throw new Error('Native-control record has different ownership or state', { cause: error });
  }
}
export async function releaseControlFence(target: ModelHostTarget, owner: ControlFence) {
  const current = await readControlFence(target);
  if (!current || !isDeepStrictEqual(current, owner)) return;
  const filename = controlFencePath(target);
  await unlink(filename);
  const directory = await open(path.dirname(filename), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
