import { createHash } from 'node:crypto';
import { object, textField } from './backup-contract.js';
import { parseRestoreJob, type RestoreJob } from './restore-contract.js';
import { OPENCLAW_PROVIDER_SETUP, openClawProviderAuthArgs } from './install.js';
import type { Provider } from '../cli/types/index.js';
import { getApiKeyParamName } from '../cli/utils/api-keys.js';

/** Recovery transport/runtime identity is shared; source identity adoption is not. */
export interface CloneJob extends RestoreJob {
  kind: 'clone';
  preview: { contentDigest: string; policyDigest: string };
  credentials: {
    primary: Provider;
    providers: Provider[];
    cloudflare?: { accountId: string; gatewayId: string };
  };
}
export function parseCloneJob(value: unknown): CloneJob {
  const row = object(value);
  const base = parseRestoreJob(row);
  const preview = object(row.preview);
  const credentials = object(row.credentials);
  if (
    row.kind !== 'clone' ||
    !/^[a-f0-9]{64}$/.test(String(preview.contentDigest)) ||
    !/^[a-f0-9]{64}$/.test(String(preview.policyDigest)) ||
    !Array.isArray(credentials.providers) ||
    !credentials.providers.length ||
    credentials.providers.length > Object.keys(OPENCLAW_PROVIDER_SETUP).length ||
    credentials.providers.some(
      (provider) =>
        typeof provider !== 'string' || !Object.hasOwn(OPENCLAW_PROVIDER_SETUP, provider),
    ) ||
    new Set(credentials.providers).size !== credentials.providers.length ||
    !credentials.providers.includes(credentials.primary)
  )
    throw new Error(
      'Clone requires a bound whole-team preview and explicit target provider selection',
    );
  const providers = [...credentials.providers] as Provider[];
  if (base.backup.capture.members.some((member) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.id)))
    throw new Error('Clone requires supported native role IDs');
  const primary = credentials.primary as Provider;
  const cloudflare =
    credentials.cloudflare === undefined ? undefined : object(credentials.cloudflare);
  const selected = {
    primary,
    providers,
    ...(cloudflare
      ? {
          cloudflare: {
            accountId: textField(cloudflare.accountId, 256),
            gatewayId: textField(cloudflare.gatewayId, 256),
          },
        }
      : {}),
  };
  openClawProviderAuthArgs({
    apiProvider: primary,
    cloudflareAccountId: selected.cloudflare?.accountId,
    cloudflareGatewayId: selected.cloudflare?.gatewayId,
  });
  return {
    ...base,
    kind: 'clone',
    preview: {
      contentDigest: preview.contentDigest as string,
      policyDigest: preview.policyDigest as string,
    },
    credentials: selected,
  };
}
export const cloneRequestDigest = (job: CloneJob) =>
  createHash('sha256').update(JSON.stringify(job)).digest('hex');

export interface CloneActivationResult {
  schemaVersion: 1;
  kind: 'clone';
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: 'active';
  healthy: true;
  memberCount: number;
  contentDigest: string;
  policyDigest: string;
  configurationHash: string;
}
export function parseCloneActivationResult(value: unknown, job: CloneJob): CloneActivationResult {
  const row = object(value);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'clone' ||
    row.operationId !== job.bootstrap.operationId ||
    row.stackId !== job.target.stackId ||
    row.instanceId !== job.target.instanceId ||
    row.phase !== 'active' ||
    row.healthy !== true ||
    row.memberCount !== job.backup.capture.members.length ||
    row.contentDigest !== job.preview.contentDigest ||
    row.policyDigest !== job.preview.policyDigest ||
    !/^[a-f0-9]{64}$/.test(String(row.configurationHash))
  )
    throw new Error('Clone activation receipt differs from its selected target and preview');
  return {
    schemaVersion: 1,
    kind: 'clone',
    operationId: job.bootstrap.operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    phase: 'active',
    healthy: true,
    memberCount: job.backup.capture.members.length,
    contentDigest: job.preview.contentDigest,
    policyDigest: job.preview.policyDigest,
    configurationHash: row.configurationHash as string,
  };
}

export interface CloneWorkerResult {
  schemaVersion: 1;
  kind: 'clone';
  operationId: string;
  stackId: string;
  instanceId: string;
  phase: 'ready-inactive';
  memberCount: number;
  fileCount: number;
  contentDigest: string;
  policyDigest: string;
  configurationHash: string;
  providerParameters: string[];
}

export function cloneTargetMembers(job: CloneJob) {
  return job.backup.capture.members.map((member) => ({
    ...member,
    workspace: `/home/ubuntu/.openclaw/workspaces/${member.id}`,
    agentDir: `/home/ubuntu/.openclaw/agents/${member.id}/agent`,
  }));
}
export function parseCloneWorkerResult(value: unknown, job: CloneJob): CloneWorkerResult {
  const ready = object(value);
  const names = job.credentials.providers.map((provider) =>
    getApiKeyParamName(job.target.deploymentName, provider),
  );
  if (
    ready.schemaVersion !== 1 ||
    ready.kind !== 'clone' ||
    ready.operationId !== job.bootstrap.operationId ||
    ready.stackId !== job.target.stackId ||
    ready.instanceId !== job.target.instanceId ||
    ready.phase !== 'ready-inactive' ||
    ready.contentDigest !== job.preview.contentDigest ||
    ready.policyDigest !== job.preview.policyDigest ||
    ready.memberCount !== job.backup.capture.members.length ||
    !Number.isSafeInteger(ready.fileCount) ||
    (ready.fileCount as number) < 0 ||
    !Array.isArray(ready.providerParameters) ||
    JSON.stringify(ready.providerParameters) !== JSON.stringify(names) ||
    !/^[a-f0-9]{64}$/.test(String(ready.configurationHash))
  )
    throw new Error('Clone completion receipt differs from this request');
  return {
    schemaVersion: 1,
    kind: 'clone',
    operationId: job.bootstrap.operationId,
    stackId: job.target.stackId,
    instanceId: job.target.instanceId,
    phase: 'ready-inactive',
    memberCount: job.backup.capture.members.length,
    fileCount: ready.fileCount as number,
    contentDigest: job.preview.contentDigest,
    policyDigest: job.preview.policyDigest,
    configurationHash: ready.configurationHash as string,
    providerParameters: names,
  };
}
