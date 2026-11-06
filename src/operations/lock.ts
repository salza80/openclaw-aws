import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CommandContext } from '../cli/utils/context.js';
import { getConfigRoot } from '../cli/utils/config.js';
import { AWSError } from '../cli/utils/errors.js';

const pending = new Map<string, Promise<void>>();
export interface DeploymentLease {
  readonly deployment: string;
}
const activeLeases = new WeakMap<DeploymentLease, string>();
/** Shared Gateway mutations serialize per AWS deployment, never per native agent. */
export async function withDeploymentLock<T>(
  ctx: CommandContext,
  operation: (lease: DeploymentLease) => Promise<T>,
  existingLease?: DeploymentLease,
): Promise<T> {
  const key = `${ctx.target.account}:${ctx.target.region}:${ctx.config.stack.name}`;
  const root = path.resolve(getConfigRoot());
  const leaseKey = `${root}:${key}`;
  if (existingLease) {
    if (activeLeases.get(existingLease) !== leaseKey)
      throw new AWSError('Deployment lease is expired or belongs to another target');
    return operation(existingLease);
  }
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  pending.set(key, queued);
  await previous;
  const directory = path.join(root, 'locks');
  const lock = path.join(directory, createHash('sha256').update(key).digest('hex'));
  let owned = false;
  const lease: DeploymentLease = Object.freeze({ deployment: key });
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      owned = true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      throw new AWSError(`Another operation holds the deployment lock for '${ctx.name}'`, [
        'Wait for the operation to finish before retrying',
        `If it crashed, verify no operation is running before removing ${lock}`,
      ]);
    }
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    activeLeases.set(lease, leaseKey);
    return await operation(lease);
  } finally {
    activeLeases.delete(lease);
    try {
      if (owned) fs.rmSync(lock, { recursive: true, force: true });
    } finally {
      release();
      if (pending.get(key) === queued) pending.delete(key);
    }
  }
}
