import { createHash } from 'node:crypto';
import { parseCloneJob, type CloneWorkerResult } from '../../../src/openclaw/clone-contract.js';
import type { CloneRecord } from '../../../src/operations/clone-record.js';
import type { ClonePreview } from '../../../src/openclaw/clone-preview.js';
import { restoreDeliveryFixture } from './restore-delivery.js';
import { backupReceipt } from './backup.js';
export function cloneDeliveryFixture() {
  const delivery = restoreDeliveryFixture();
  const job = parseCloneJob({
    ...delivery.job,
    kind: 'clone',
    preview: { contentDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64) },
    credentials: { primary: 'openrouter-api-key', providers: ['openrouter-api-key'] },
  });
  return {
    ...delivery,
    job,
    request: {
      ...delivery.request,
      key: delivery.request.key.replace('/restore/', '/clone/'),
      sha256: createHash('sha256').update(JSON.stringify(job)).digest('hex'),
    },
  };
}
export function clonePreviewFixture(): ClonePreview {
  return {
    schemaVersion: 1,
    scope: 'whole-team-knowledge',
    policyDigest: 'b'.repeat(64),
    providersInUse: ['openrouter'],
    policy: {
      schemaVersion: 1,
      agents: [{ id: 'main' }],
      credentialPaths: [],
      omissions: ['Source channels, history and external connections are excluded.'],
    },
    content: {
      schemaVersion: 1,
      digest: 'a'.repeat(64),
      members: [
        {
          id: 'main',
          workspace: '/home/ubuntu/.openclaw/workspaces/main',
          agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
          model: 'openrouter/fixture-model',
          files: [{ path: 'MEMORY.md', bytes: 3, sha256: 'c'.repeat(64) }],
          omitted: [{ path: '.env', reason: 'credential file' }],
        },
      ],
    },
  };
}
export function cloneRecordFixture(): CloneRecord {
  const delivery = cloneDeliveryFixture();
  const result: CloneWorkerResult = {
    schemaVersion: 1,
    kind: 'clone',
    operationId: delivery.job.bootstrap.operationId,
    stackId: delivery.job.target.stackId,
    instanceId: delivery.job.target.instanceId,
    phase: 'ready-inactive',
    memberCount: 1,
    fileCount: 1,
    ...delivery.job.preview,
    configurationHash: 'c'.repeat(64),
    providerParameters: ['/openclaw/restored/providers/openrouter-api-key/api-key'],
  };
  return {
    schemaVersion: 1,
    kind: 'clone',
    account: delivery.job.target.account,
    partition: 'aws',
    operationId: delivery.job.bootstrap.operationId,
    phase: 'ready-inactive',
    name: 'restored',
    config: {
      version: '1.0',
      aws: { region: delivery.job.target.region },
      network: { useDefaultVpc: true },
      instance: { type: 't3a.small', name: 'restored' },
      features: { cloudWatchLogs: false },
      stack: { name: 'OpenclawStack-restored' },
      openclaw: { apiProvider: 'openrouter-api-key' },
    },
    bootstrap: delivery.job.bootstrap,
    target: { stackId: delivery.job.target.stackId, instanceId: delivery.job.target.instanceId },
    recovery: {
      uri: backupReceipt.vaultUri,
      region: backupReceipt.job.source.region,
      pointId: backupReceipt.id,
    },
    preview: delivery.job.preview,
    credentials: delivery.job.credentials,
    report: {
      copiedFiles: 1,
      omittedEntries: 1,
      agentIds: ['main'],
      omissions: ['Source channels, history and external connections are excluded.'],
      providersInUse: ['openrouter'],
    },
    delivery,
    result,
  };
}
