import { createHash } from 'node:crypto';
import { object, textField } from './backup-contract.js';
import { parseRestoreJob, type RestoreJob } from './restore-contract.js';
import { OPENCLAW_PROVIDER_SETUP, openClawProviderAuthArgs } from './install.js';
import type { Provider } from '../cli/types/index.js';

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
