import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadCloneRecord,
  saveCloneRecord,
  type CloneRecord,
} from '../../src/operations/clone-record.js';
import { recoveryRecordPath } from '../../src/operations/recovery-record.js';
import { cloneRecordFixture, cloneBedrockPlan } from '../helpers/fixtures/clone.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'clone-record-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
describe('resumable clone journal', () => {
  it('persists keyless role setup without inventing a model credential or initial model', () => {
    const record = cloneRecordFixture();
    record.phase = 'cloning';
    delete record.delivery;
    delete record.result;
    record.bedrock = cloneBedrockPlan();
    record.config.openclaw = {
      apiProvider: 'amazon-bedrock',
      authMode: 'instance-role',
      bedrock: { region: record.bedrock.intent.inferenceRegion },
    };
    record.credentials = { primary: 'amazon-bedrock', providers: [] };
    saveCloneRecord(record);
    expect(loadCloneRecord(record.operationId)).toEqual(record);
  });
  it('privately pins account, target, exact delivery, preview, providers and content result', () => {
    const record = cloneRecordFixture();
    saveCloneRecord(record, true);
    expect(loadCloneRecord(record.operationId)).toEqual(record);
    expect(fs.statSync(recoveryRecordPath('clones', record.operationId)).mode & 0o077).toBe(0);
    expect(() => saveCloneRecord(record, true)).toThrow();
  });
  it('rejects target, provider, preview, lineage, delivery and completion drift', () => {
    const mutations: ((record: CloneRecord) => void)[] = [
      (record) => {
        record.account = '999999999999';
      },
      (record) => {
        record.partition = 'aws-cn';
      },
      (record) => {
        record.preview.contentDigest = 'd'.repeat(64);
      },
      (record) => {
        record.credentials.providers = ['anthropic-api-key'];
      },
      (record) => {
        record.delivery!.request.key = record.delivery!.request.key.replace('/clone/', '/restore/');
      },
      (record) => {
        record.delivery!.request.sha256 = 'd'.repeat(64);
      },
      (record) => {
        record.recovery.pointId = '33333333-3333-3333-3333-333333333333';
      },
      (record) => {
        record.result!.fileCount = 9;
      },
      (record) => {
        record.report.agentIds = ['unrelated'];
      },
      (record) => {
        record.phase = 'active';
      },
      (record) => {
        delete record.result;
      },
    ];
    for (const mutate of mutations) {
      const record = cloneRecordFixture();
      mutate(record);
      saveCloneRecord(record);
      expect(() => loadCloneRecord(record.operationId)).toThrow();
    }
  });
  it('filters arbitrary diagnostics and never publishes unknown journal fields', () => {
    const record = cloneRecordFixture();
    saveCloneRecord(record);
    const filename = recoveryRecordPath('clones', record.operationId);
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    raw.result.apiKey = 'do-not-publish';
    raw.auth = { key: 'do-not-publish' };
    fs.writeFileSync(filename, JSON.stringify(raw));
    expect(JSON.stringify(loadCloneRecord(record.operationId))).not.toContain('do-not-publish');
  });
});
