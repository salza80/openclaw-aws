import { object, textField } from '../openclaw/backup-contract.js';
import {
  parseCloneJob,
  parseCloneWorkerResult,
  parseCloneActivationResult,
  type CloneJob,
  type CloneWorkerResult,
  type CloneActivationResult,
} from '../openclaw/clone-contract.js';
import { OPENCLAW_PROVIDER_SETUP } from '../openclaw/install.js';
import { validateProvisioningConfig } from '../cli/utils/config-validation.js';
import type { ClonePreview } from '../openclaw/clone-preview.js';
import {
  parseRecoveryRecordBase,
  parseRecoveryDelivery,
  readRecoveryRecord,
  saveRecoveryRecord,
  type RecoveryRecordBase,
  type RecoveryDelivery,
} from './recovery-record.js';
export interface CloneReport {
  copiedFiles: number;
  omittedEntries: number;
  agentIds: string[];
  omissions: string[];
  providersInUse: string[];
}
export interface CloneRecord extends RecoveryRecordBase<
  'provisioning' | 'cloning' | 'ready-inactive' | 'active'
> {
  account: string;
  partition: string;
  kind: 'clone';
  preview: CloneJob['preview'];
  credentials: CloneJob['credentials'];
  report: CloneReport;
  delivery?: RecoveryDelivery<CloneJob>;
  result?: CloneWorkerResult;
  activation?: CloneActivationResult;
}
export function cloneReport(preview: ClonePreview): CloneReport {
  const scopes = [
    ...preview.content.members,
    ...preview.content.members.flatMap((member) =>
      member.workshopSkills ? [member.workshopSkills] : [],
    ),
    ...(preview.content.sharedSkills ? [preview.content.sharedSkills] : []),
  ];
  return {
    copiedFiles: scopes.reduce((sum, scope) => sum + scope.files.length, 0),
    omittedEntries: scopes.reduce((sum, scope) => sum + scope.omitted.length, 0),
    agentIds: preview.content.members.map((member) => member.id),
    omissions: [...preview.policy.omissions],
    providersInUse: [...preview.providersInUse],
  };
}
export const saveCloneRecord = (record: CloneRecord, create = false) =>
  saveRecoveryRecord('clones', record, create);
export function loadCloneRecord(operationId: string): CloneRecord {
  const value = readRecoveryRecord('clones', operationId);
  const base = parseRecoveryRecordBase(value, operationId, [
    'provisioning',
    'cloning',
    'ready-inactive',
    'active',
  ]);
  validateProvisioningConfig(base.config, { clonedModelPolicy: true });
  if (!base.account || !base.partition) throw new Error('Clone target account is not pinned');
  const preview = object(value.preview);
  const credentials = object(value.credentials);
  const report = object(value.report);
  if (
    value.kind !== 'clone' ||
    !/^[a-f0-9]{64}$/.test(String(preview.contentDigest)) ||
    !/^[a-f0-9]{64}$/.test(String(preview.policyDigest)) ||
    !Array.isArray(credentials.providers) ||
    credentials.providers.some(
      (provider) =>
        typeof provider !== 'string' || !Object.hasOwn(OPENCLAW_PROVIDER_SETUP, provider),
    ) ||
    new Set(credentials.providers).size !== credentials.providers.length ||
    (credentials.primary === 'amazon-bedrock'
      ? !base.bedrock
      : !credentials.providers.includes(credentials.primary)) ||
    credentials.primary !== base.config.openclaw?.apiProvider ||
    JSON.stringify(credentials.cloudflare ?? null) !==
      JSON.stringify(base.config.openclaw?.cloudflare ?? null)
  )
    throw new Error('Clone journal has inconsistent preview or target credential selection');
  const count = (value: unknown) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error('Invalid clone report count');
    return value as number;
  };
  const list = (value: unknown, max: number) => {
    if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid clone report list');
    return value.map((item) => textField(item, max));
  };
  const agentIds = list(report.agentIds, 64);
  if (
    !agentIds.length ||
    new Set(agentIds).size !== agentIds.length ||
    agentIds.some((id) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
  )
    throw new Error('Invalid clone report roster');
  const record: CloneRecord = {
    ...base,
    account: base.account,
    partition: base.partition,
    kind: 'clone',
    preview: {
      contentDigest: preview.contentDigest as string,
      policyDigest: preview.policyDigest as string,
    },
    credentials: {
      primary: credentials.primary as CloneJob['credentials']['primary'],
      providers: credentials.providers as CloneJob['credentials']['providers'],
      ...(base.config.openclaw?.cloudflare ? { cloudflare: base.config.openclaw.cloudflare } : {}),
    },
    report: {
      copiedFiles: count(report.copiedFiles),
      omittedEntries: count(report.omittedEntries),
      agentIds,
      omissions: list(report.omissions, 1024),
      providersInUse: list(report.providersInUse, 64),
    },
  };
  if (value.delivery !== undefined) {
    record.delivery = parseRecoveryDelivery(value.delivery, record, 'clone', parseCloneJob);
    if (
      JSON.stringify(record.delivery.job.preview) !== JSON.stringify(record.preview) ||
      JSON.stringify(record.delivery.job.credentials) !== JSON.stringify(record.credentials) ||
      JSON.stringify(record.delivery.job.backup.capture.members.map((member) => member.id)) !==
        JSON.stringify(agentIds)
    )
      throw new Error('Clone delivery selection changed');
  }
  if (value.result !== undefined) {
    if (!record.delivery) throw new Error('Clone result has no pinned delivery');
    record.result = parseCloneWorkerResult(value.result, record.delivery.job);
    if (record.result.fileCount !== record.report.copiedFiles)
      throw new Error('Clone result file count differs from preview');
  }
  if (value.activation !== undefined) {
    if (!record.delivery || !record.result)
      throw new Error('Clone activation has no certified staging result');
    record.activation = parseCloneActivationResult(value.activation, record.delivery.job);
    if (record.activation.configurationHash !== record.result.configurationHash)
      throw new Error('Clone activated a different configuration');
  }
  if ((record.phase === 'ready-inactive' || record.phase === 'active') && !record.result)
    throw new Error('Clone phase has no certified staging result');
  if (record.phase === 'active' && !record.activation)
    throw new Error('Active clone has no activation receipt');
  return record;
}
