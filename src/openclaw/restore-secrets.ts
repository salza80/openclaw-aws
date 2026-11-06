import {
  GetParameterCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';
import { OPENCLAW_PROVIDER_SETUP } from './install.js';
import { getApiKeyParamName } from '../cli/utils/api-keys.js';
import type { Provider } from '../cli/types/index.js';

export interface RestoreSecretOwner {
  deploymentName: string;
  deploymentId: string;
  operationId: string;
}

/** The caller supplies a client for the verified target account. Values stay private.
 * Every write is create-only; a retry may adopt only an identical value tagged to
 * this exact target stack and restore operation.
 */
export async function importRestoreProviderSecrets(
  client: Pick<SSMClient, 'send'>,
  owner: RestoreSecretOwner,
  environment: Record<string, string>,
): Promise<{ providers: Provider[]; parameterNames: string[] }> {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(owner.deploymentName) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.operationId) ||
    !new RegExp(
      `^arn:[a-z0-9-]+:cloudformation:[a-z0-9-]+:[0-9]{12}:stack/OpenclawStack-${owner.deploymentName}/[A-Za-z0-9-]+$`,
    ).test(owner.deploymentId)
  )
    throw new Error('Invalid restore secret owner');
  const tags = [
    { Key: 'openclaw-aws:deployment-id', Value: owner.deploymentId },
    { Key: 'openclaw-aws:restore-id', Value: owner.operationId },
  ];
  const entries = Object.entries(OPENCLAW_PROVIDER_SETUP).flatMap(([provider, setup]) => {
    const value = environment[setup.envVar];
    if (value === undefined || value === '') return [];
    if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || value.includes('\0'))
      throw new Error('A restored provider credential exceeds the supported SSM secret format');
    return [
      {
        provider: provider as Provider,
        value,
        name: getApiKeyParamName(owner.deploymentName, provider as Provider),
      },
    ];
  });
  for (const entry of entries) {
    const signal = AbortSignal.timeout(30000);
    let outcome: 'created' | 'existing' | 'failed' = 'created';
    try {
      await client.send(
        new PutParameterCommand({
          Name: entry.name,
          Type: 'SecureString',
          Value: entry.value,
          Overwrite: false,
          Tags: tags,
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      // Discard SDK write errors: their request context can contain the secret.
      outcome =
        error instanceof Error && error.name === 'ParameterAlreadyExists' ? 'existing' : 'failed';
    }
    if (outcome === 'failed')
      throw new Error(
        'Restored provider secret import failed; target remains inactive and previously created owned secrets are retained for retry',
      );
    if (outcome === 'existing') {
      const existingTags = await client.send(
        new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: entry.name }),
        { abortSignal: signal },
      );
      if (
        !tags.every((tag) =>
          existingTags.TagList?.some((saved) => saved.Key === tag.Key && saved.Value === tag.Value),
        )
      )
        throw new Error(
          'An existing provider secret belongs to another deployment or restore operation',
        );
      const existing = await client.send(
        new GetParameterCommand({ Name: entry.name, WithDecryption: true }),
        { abortSignal: signal },
      );
      if (
        existing.Parameter?.Name !== entry.name ||
        existing.Parameter.Type !== 'SecureString' ||
        existing.Parameter.Value !== entry.value
      )
        throw new Error(
          'An owned restored provider secret differs from the saved credential; no value was overwritten',
        );
    }
  }
  return {
    providers: entries.map((entry) => entry.provider),
    parameterNames: entries.map((entry) => entry.name),
  };
}
