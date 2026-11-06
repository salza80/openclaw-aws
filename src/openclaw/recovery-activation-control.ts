import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { RestoreJob } from './restore-contract.js';
import { privateRestoreJson } from './restore-control.js';
import { isDeepStrictEqual } from 'node:util';
export async function assertRecoveryMaintenance(
  root: string,
  job: RestoreJob,
  kind: 'restore' | 'clone',
  digest: string,
) {
  const record = await privateRestoreJson(path.join(root, 'maintenance.json'));
  if (
    record.kind !== kind ||
    record.operationId !== job.bootstrap.operationId ||
    record.stackId !== job.target.stackId ||
    record.roleId !== job.target.roleId ||
    record.digest !== digest
  )
    throw new Error('Another maintenance operation owns this target');
}
export async function releaseRecoveryMaintenance(
  root: string,
  job: RestoreJob,
  kind: 'restore' | 'clone',
  digest: string,
) {
  try {
    await assertRecoveryMaintenance(root, job, kind, digest);
    await rm(path.join(root, 'maintenance.json'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

/** Adopt a completed reply, or retry a rolled-back commit only while the same
 * operation still owns a confirmed inactive hold. Never restart an unknown host.
 */
export async function adoptRecoveryActivation(options: {
  activatedFile: string;
  expected: object;
  validate: () => Promise<void>;
  health: () => Promise<void>;
  release: () => Promise<void>;
  assertInactive: () => Promise<void>;
  assertMaintenance: () => Promise<void>;
}): Promise<boolean> {
  let activated: object;
  try {
    activated = await privateRestoreJson(options.activatedFile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!isDeepStrictEqual(activated, options.expected))
    throw new Error('Existing activation receipt differs from this recovery request');
  await options.validate();
  try {
    await options.health();
    await options.release();
    return true;
  } catch {
    await options.assertInactive();
    await options.assertMaintenance();
    return false;
  }
}
