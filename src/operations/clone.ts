import type { AwsTarget } from '../aws/target.js';
import type { Provider } from '../cli/types/index.js';
import { validateProjectName } from '../cli/utils/validation.js';
import { OPENCLAW_PROVIDER_SETUP, openClawProviderAuthArgs } from '../openclaw/install.js';
import { previewSavedClone } from './clone-preview.js';
import { prepareInactiveRecoveryTarget } from './recovery-target.js';
import { backupOperationId } from './backup.js';

/** Whole-team knowledge clone intake. Source infrastructure may still be live;
 * source identity is not adopted, so no takeover/destruction check is required.
 */
export async function prepareClone(options: {
  recoveryTarget: AwsTarget;
  vaultUri: string;
  pointId: string;
  name: string;
  apiProvider: Provider;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  region?: string;
  profile?: string;
  instanceType?: string;
  volumeGiB?: number;
  operationId?: string;
  signal?: AbortSignal;
}) {
  const name = validateProjectName(options.name);
  if (name !== true) throw new Error(String(name));
  if (!Object.hasOwn(OPENCLAW_PROVIDER_SETUP, options.apiProvider))
    throw new Error('Unsupported clone model provider');
  openClawProviderAuthArgs(options);
  const operationId = backupOperationId(options.operationId);
  options.signal?.throwIfAborted();
  const { point, preview } = await previewSavedClone(options);
  let additionalStagingBytes = 0;
  const scopes = [
    ...preview.content.members,
    ...preview.content.members.flatMap((member) =>
      member.workshopSkills ? [member.workshopSkills] : [],
    ),
    ...(preview.content.sharedSkills ? [preview.content.sharedSkills] : []),
  ];
  for (const scope of scopes)
    for (const file of scope.files) {
      additionalStagingBytes += file.bytes;
      if (!Number.isSafeInteger(additionalStagingBytes) || file.bytes < 0)
        throw new Error('Clone workspace size exceeds its supported staging bound');
    }
  const plan = await prepareInactiveRecoveryTarget({
    ...options,
    point,
    operationId,
    kind: 'clone',
    additionalStagingBytes,
    openclaw: {
      apiProvider: options.apiProvider,
      ...(options.apiProvider === 'cloudflare-ai-gateway-api-key'
        ? {
            cloudflare: {
              accountId: options.cloudflareAccountId!,
              gatewayId: options.cloudflareGatewayId!,
            },
          }
        : {}),
    },
  });
  options.signal?.throwIfAborted();
  return { ...plan, schemaVersion: 1 as const, preview };
}
export type ClonePlan = Awaited<ReturnType<typeof prepareClone>>;
