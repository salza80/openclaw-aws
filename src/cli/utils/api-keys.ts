import type { Provider } from '../types/index.js';

export const API_KEY_PLACEHOLDER = '---yourkey---';

const KNOWN_PLACEHOLDERS = new Set([
  API_KEY_PLACEHOLDER,
  '---your-api-key---',
  'your-api-key',
  '<your-api-key>',
  'changeme',
]);

export function getApiKeyEnvVar(provider: Provider): string {
  return provider.toUpperCase().replace(/-/g, '_');
}

export function getApiKeyParamName(configName: string, provider: Provider): string {
  return `/openclaw/${configName}/providers/${provider}/api-key`;
}

export function resolveApiKey(provider: Provider): string | undefined {
  const envVarName = getApiKeyEnvVar(provider);
  const value = process.env[envVarName];
  return typeof value === 'string' ? value.trim() : undefined;
}

export function isApiKeyConfigured(apiKey: string | undefined): apiKey is string {
  if (typeof apiKey !== 'string') {
    return false;
  }

  const normalized = apiKey.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return !KNOWN_PLACEHOLDERS.has(normalized);
}

export function getGatewayTokenParamName(configName: string): string {
  return `/openclaw/${configName}/gateway-token`;
}
