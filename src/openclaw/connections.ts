import type { ApiKeyProvider, OpenClawConfig, Provider } from '../cli/types/index.js';
import { API_PROVIDERS } from '../cli/constants.js';
import { validAwsRegion } from '../aws/regions.js';

export const BEDROCK_PROVIDER = 'amazon-bedrock' as const;
export const PROVIDER_CONNECTIONS = [
  ...API_PROVIDERS,
  {
    title: 'Amazon Bedrock (AWS instance role)',
    value: BEDROCK_PROVIDER,
    description: 'AWS-billed models without a model API key',
  },
] as const;
export function isApiKeyProvider(value: unknown): value is ApiKeyProvider {
  return API_PROVIDERS.some((provider) => provider.value === value);
}
export type ModelConnection =
  | { provider: ApiKeyProvider; authMode: 'api-key' }
  | { provider: typeof BEDROCK_PROVIDER; authMode: 'instance-role'; region: string };
/** Resolve initial setup intent only. Runtime model selection must not retarget
 * this provider's credential path or infer a connection from an AWS profile. */
export function initialModelConnection(config: Pick<OpenClawConfig, 'openclaw'>): ModelConnection {
  const setup = config.openclaw;
  const provider: Provider = setup?.apiProvider ?? 'anthropic-api-key';
  if (provider === BEDROCK_PROVIDER) {
    if (
      setup?.authMode !== 'instance-role' ||
      !setup.bedrock ||
      Object.keys(setup.bedrock).some((key) => key !== 'region') ||
      !validAwsRegion(setup.bedrock.region)
    )
      throw new Error(
        'Bedrock setup requires instance-role authentication and an explicit inference region',
      );
    return { provider, authMode: 'instance-role', region: setup.bedrock.region };
  }
  if (
    !isApiKeyProvider(provider) ||
    (setup?.authMode !== undefined && setup.authMode !== 'api-key') ||
    setup?.bedrock !== undefined
  )
    throw new Error(
      'API-key setup cannot declare instance-role authentication or Bedrock connection settings',
    );
  return { provider, authMode: 'api-key' };
}
export type FreshProviderCredentials =
  | { apiProvider: ApiKeyProvider; apiKey: string }
  | { apiProvider: typeof BEDROCK_PROVIDER; apiKey?: never };
export function freshProviderCredentials(
  provider: Provider,
  apiKey?: string,
): FreshProviderCredentials {
  if (provider === BEDROCK_PROVIDER) {
    if (apiKey !== undefined)
      throw new Error('Bedrock instance-role setup cannot receive a model API key');
    return { apiProvider: provider };
  }
  if (!isApiKeyProvider(provider) || !apiKey)
    throw new Error('API-key setup requires an explicit model credential');
  return { apiProvider: provider, apiKey };
}
