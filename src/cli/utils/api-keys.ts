import type { ApiKeyProvider } from '../types/index.js';
import { isApiKeyProvider } from '../../openclaw/connections.js';

export function getApiKeyEnvVar(provider: ApiKeyProvider): string {
  if (!isApiKeyProvider(provider))
    throw new Error('Instance-role providers do not have model API-key environment variables');
  return provider.toUpperCase().replace(/-/g, '_');
}

export function getApiKeyParamName(configName: string, provider: ApiKeyProvider): string {
  if (!isApiKeyProvider(provider))
    throw new Error('Instance-role providers do not have model API-key SSM parameters');
  return `/openclaw/${configName}/providers/${provider}/api-key`;
}

export function resolveApiKey(provider: ApiKeyProvider): string | undefined {
  const envVarName = getApiKeyEnvVar(provider);
  return process.env[envVarName];
}

export function getGatewayTokenParamName(configName: string): string {
  return `/openclaw/${configName}/gateway-token`;
}
