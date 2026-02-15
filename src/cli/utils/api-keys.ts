import type { Provider } from '../types/index.js';

export function getApiKeyEnvVar(provider: Provider): string {
  return provider.toUpperCase().replace(/-/g, '_');
}

export function getApiKeyParamName(configName: string, provider: Provider): string {
  return `/openclaw/${configName}/providers/${provider}/api-key`;
}

export function resolveApiKey(provider: Provider): string | undefined {
  const envVarName = getApiKeyEnvVar(provider);
  return process.env[envVarName];
}

export function getGatewayTokenParamName(configName: string): string {
  return `/openclaw/${configName}/gateway-token`;
}
