import type { RestoreJob } from '../openclaw/restore-contract.js';
import { parseRestoreJob } from '../openclaw/restore-contract.js';
import { object } from '../openclaw/backup-contract.js';
import type { RestoreWorkerResult } from '../openclaw/restore-worker.js';
import type { RestoreActivationResult } from '../openclaw/restore-activation.js';
import {
  recoveryRecordPath,
  saveRecoveryRecord,
  readRecoveryRecord,
  parseRecoveryRecordBase,
  parseRecoveryDelivery,
  type RecoveryRecordBase,
  type RecoveryDelivery,
} from './recovery-record.js';
export type RestoreDelivery = RecoveryDelivery<RestoreJob>;
export interface RestoreRecord extends RecoveryRecordBase<
  'provisioning' | 'restoring' | 'ready-inactive' | 'active-held'
> {
  delivery?: RestoreDelivery;
  result?: RestoreWorkerResult;
  activation?: RestoreActivationResult;
}
export const restoreRecordPath = (operationId: string) =>
  recoveryRecordPath('restores', operationId);
export function saveRestoreRecord(record: RestoreRecord, create = false) {
  saveRecoveryRecord('restores', record, create);
}
export function loadRestoreRecord(operationId: string): RestoreRecord {
  const value = readRecoveryRecord('restores', operationId);
  const record: RestoreRecord = parseRecoveryRecordBase(value, operationId, [
    'provisioning',
    'restoring',
    'ready-inactive',
    'active-held',
  ]);
  if (value.delivery !== undefined)
    record.delivery = parseRecoveryDelivery(value.delivery, record, 'restore', parseRestoreJob);
  // Results are historical metadata. Expose only the allowlist, then recheck live state.
  for (const key of ['result', 'activation'] as const) {
    if (!value[key]) continue;
    const saved = object(value[key]);
    if (
      !record.target ||
      saved.schemaVersion !== 1 ||
      saved.operationId !== operationId ||
      saved.stackId !== record.target.stackId ||
      saved.instanceId !== record.target.instanceId ||
      !Number.isSafeInteger(saved.memberCount) ||
      (saved.memberCount as number) < 1 ||
      !Number.isSafeInteger(saved.heldSessionCount) ||
      (saved.heldSessionCount as number) < 0
    )
      throw new Error('Historical restore result has inconsistent ownership or counts');
    const common = {
      schemaVersion: 1 as const,
      operationId,
      stackId: record.target.stackId,
      instanceId: record.target.instanceId,
      memberCount: saved.memberCount as number,
      heldSessionCount: saved.heldSessionCount as number,
    };
    if (key === 'result') {
      if (
        saved.phase !== 'ready-inactive' ||
        !Array.isArray(saved.providerParameters) ||
        saved.providerParameters.some(
          (name) =>
            typeof name !== 'string' ||
            !new RegExp(`^/openclaw/${record.name}/providers/[a-z0-9-]+/api-key$`).test(name),
        )
      )
        throw new Error('Invalid historical inactive restore result');
      record.result = {
        ...common,
        phase: 'ready-inactive',
        providerParameters: saved.providerParameters as string[],
      };
    } else {
      if (saved.phase !== 'active-held' || saved.healthy !== true)
        throw new Error('Invalid historical activation result');
      record.activation = { ...common, phase: 'active-held', healthy: true };
    }
  }
  return record;
}
