import type { BackupCaptureJob, CapturedBackup } from '../../../src/openclaw/backup-contract.js';
import type { RecoveryVault } from '../../../src/operations/vault.js';
import type { RecoverySource } from '../../../src/aws/recovery-source.js';
import { sourceHash } from '../../../src/aws/recovery-source.js';
import type { BackupReceipt } from '../../../src/operations/backup.js';
export const backupId = '11111111-1111-1111-1111-111111111111';
export const backupSource: RecoverySource = {
  stackId: 'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-alpha/stack-guid',
  stackName: 'OpenclawStack-alpha',
  instanceId: 'i-0123456789abcdef0',
  role: {
    id: 'AROA-FIXTURE',
    name: 'source-role',
    arn: 'arn:aws:iam::123456789012:role/source-role',
  },
  profile: { id: 'AIPA-FIXTURE', arn: 'arn:aws:iam::123456789012:instance-profile/source-profile' },
  instance: {
    type: 't3a.small',
    minimumDiskGiB: 30,
    architecture: 'x86_64',
    imageId: 'ami-123',
    subnetId: 'subnet-123',
    vpcId: 'vpc-123',
  },
  resources: [{ type: 'AWS::IAM::Role', id: 'source-role' }],
};
export const backupVault: RecoveryVault = {
  schemaVersion: 1,
  kind: 'openclaw-aws-vault',
  id: 'a'.repeat(32),
  uri: 's3://private-backups/vault/main',
  account: '123456789012',
  region: 'eu-central-1',
  createdAt: '2026-11-06T00:00:00.000Z',
  retention: 'indefinite',
  encryption: {},
  key: {
    arn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:vault-abcdef',
    versionId: backupId,
    versionStage: `openclaw-aws-vault-${'a'.repeat(32)}`,
  },
};
export const backupJob: BackupCaptureJob = {
  schemaVersion: 1,
  operationId: backupId,
  source: {
    stackId: backupSource.stackId,
    instanceId: backupSource.instanceId,
    roleId: backupSource.role.id,
    account: '123456789012',
    region: 'eu-central-1',
  },
  settings: {
    bucket: 'private-backups',
    region: 'eu-central-1',
    expectedBucketOwner: '123456789012',
    prefix: `vault/main/native/${sourceHash(backupSource.stackId)}`,
    credentialSource: 'instance-role',
  },
  key: backupVault.key,
  namespace: 'installation',
  pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${'b'.repeat(64)}`,
};
export const backupCapture: CapturedBackup = {
  schemaVersion: 1,
  operationId: backupId,
  runtime: { openclaw: '2026.11.1', node: '24.22.2' },
  capture: {
    createdAt: '2026-11-06T00:00:00.000Z',
    assets: [
      { kind: 'state', sourcePath: '/home/ubuntu/.openclaw' },
      { kind: 'workspace', sourcePath: '/home/ubuntu/workspace' },
    ],
    agentRoots: [{ agentId: 'main', sourcePath: '/home/ubuntu/.openclaw/agents/main/agent' }],
    skipped: [
      { kind: 'config', sourcePath: '/home/ubuntu/.openclaw/openclaw.json', reason: 'covered' },
    ],
    skippedVolatileCount: 0,
    warnings: [],
    location: {
      key: '20261106T000000Z-12345678.tar.gz',
      namespace: 'installation',
      locationId: 'location',
      plaintextBytes: 100,
      storedBytes: 200,
    },
  },
  members: [
    {
      id: 'main',
      workspace: '/home/ubuntu/workspace',
      agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
      model: 'openrouter/fixture-model',
    },
  ],
  verification: {
    ok: true,
    runtimeVersion: '2026.11.1',
    createdAt: '2026-11-06T00:00:00.000Z',
    archiveRoot: 'archive',
    assetCount: 2,
    entryCount: 10,
    symlinkCount: 0,
    sqliteInventoryVerified: true,
  },
  objects: {
    'openclaw-storage.json': { versionId: 'marker-version', storedBytes: 100 },
    'backups/installation/20261106T000000Z-12345678.tar.gz': {
      versionId: 'archive-version',
      storedBytes: 200,
    },
  },
  credentials: {
    mode: 'full-native',
    configurationPath: '/home/ubuntu/.openclaw/openclaw.json',
    sourceEnvironmentIncluded: true,
    prerequisites: ['Reinstall pinned runtime and declared plugins.'],
  },
  omissions: ['Native volatile queues and managed caches omitted.'],
  gateway: { initial: 'active', restored: true },
};
export const backupReceipt: BackupReceipt = {
  schemaVersion: 1,
  kind: 'openclaw-aws-backup',
  id: backupId,
  vaultId: backupVault.id,
  vaultUri: backupVault.uri,
  completedAt: '2026-11-06T00:00:00.000Z',
  job: backupJob,
  source: { ...backupSource, resources: [] },
  capture: backupCapture,
};
export const restoreJobFixture = {
  schemaVersion: 1 as const,
  bootstrap: {
    operationId: '22222222-2222-2222-2222-222222222222',
    volumeGiB: 30,
    runtime: backupCapture.runtime,
  },
  target: {
    deploymentName: 'restored',
    stackId:
      'arn:aws:cloudformation:us-east-1:123456789012:stack/OpenclawStack-restored/target-guid',
    instanceId: 'i-11111111111111111',
    roleId: 'AROA-TARGET',
    region: 'us-east-1',
    account: '123456789012',
  },
  backup: { job: backupJob, capture: backupCapture },
  pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${'c'.repeat(64)}`,
};
