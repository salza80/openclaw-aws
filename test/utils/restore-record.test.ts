import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadRestoreRecord,
  restoreRecordPath,
  saveRestoreRecord,
  type RestoreRecord,
} from '../../src/operations/restore-record.js';
import { backupReceipt } from '../helpers/fixtures/backup.js';
import { restoreDeliveryFixture } from '../helpers/fixtures/restore-delivery.js';
let directory: string;
let record: RestoreRecord;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'restore-record-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  const delivery = restoreDeliveryFixture();
  record = {
    schemaVersion: 1,
    operationId: delivery.job.bootstrap.operationId,
    phase: 'ready-inactive',
    name: 'restored',
    bootstrap: delivery.job.bootstrap,
    config: {
      version: '1.0',
      aws: { region: 'us-east-1' },
      network: { useDefaultVpc: true },
      features: { cloudWatchLogs: false },
      instance: { type: 't3a.small', name: 'restored' },
      stack: { name: 'OpenclawStack-restored' },
    },
    target: { stackId: delivery.job.target.stackId, instanceId: delivery.job.target.instanceId },
    recovery: { uri: backupReceipt.vaultUri, region: 'eu-central-1', pointId: backupReceipt.id },
    delivery,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
describe('private resumable restore records', () => {
  it('retains exact code/request versions and hashes in a private create-only record', () => {
    saveRestoreRecord(record, true);
    expect(loadRestoreRecord(record.operationId)).toEqual(record);
    expect(fs.statSync(restoreRecordPath(record.operationId)).mode & 0o077).toBe(0);
    expect(() => saveRestoreRecord(record, true)).toThrow();
  });
  it('refuses changed targets, cross-prefix code, checksum drift and mismatched operation ownership', () => {
    for (const mutate of [
      (copy: RestoreRecord) => {
        copy.target!.instanceId = 'i-22222222222222222';
      },
      (copy: RestoreRecord) => {
        copy.delivery!.artifact.files[0].key = 'another-claw/code';
      },
      (copy: RestoreRecord) => {
        copy.delivery!.request.sha256 = 'a'.repeat(64);
      },
      (copy: RestoreRecord) => {
        copy.delivery!.artifact.files[0].sha256 = 'b'.repeat(64);
      },
      (copy: RestoreRecord) => {
        copy.name = 'another';
      },
      (copy: RestoreRecord) => {
        copy.delivery!.request.versionId = 'null';
      },
      (copy: RestoreRecord) => {
        copy.delivery!.artifact.files[0].versionId = 'unsafe\nversion';
      },
    ]) {
      const copy = structuredClone(record);
      mutate(copy);
      saveRestoreRecord(copy);
      expect(() => loadRestoreRecord(record.operationId)).toThrow();
    }
  });
  it('filters historical result fields and never treats unknown fields as public diagnostics', () => {
    const common = {
      schemaVersion: 1 as const,
      operationId: record.operationId,
      stackId: record.target!.stackId,
      instanceId: record.target!.instanceId,
      memberCount: 1,
      heldSessionCount: 2,
    };
    record.result = {
      ...common,
      phase: 'ready-inactive',
      providerParameters: ['/openclaw/restored/providers/openrouter-api-key/api-key'],
    };
    saveRestoreRecord(record);
    const raw = JSON.parse(fs.readFileSync(restoreRecordPath(record.operationId), 'utf8'));
    raw.result.privateDiagnostic = 'do-not-publish';
    fs.writeFileSync(restoreRecordPath(record.operationId), JSON.stringify(raw));
    expect(JSON.stringify(loadRestoreRecord(record.operationId))).not.toContain('do-not-publish');
  });
  it('refuses unsafe permissions and operation path traversal', () => {
    saveRestoreRecord(record);
    fs.chmodSync(restoreRecordPath(record.operationId), 0o644);
    expect(() => loadRestoreRecord(record.operationId)).toThrow('unsafe');
    expect(() => restoreRecordPath('../other')).toThrow('UUID');
  });
});
