import { modelObject } from '../openclaw/model-contract.js';
import { teamId } from '../openclaw/team-contract.js';
import { OPENCLAW_PROVIDER_SETUP } from '../openclaw/install.js';
import type { ApiKeyProvider } from '../cli/types/index.js';
import { getApiKeyParamName } from '../cli/utils/api-keys.js';

/** Nonsecret fresh-install inputs. Only declared deployment-owned key names
 * enter CDK; values are written privately by the application beforehand. */
export interface TeamBootstrap {
  teamId: string;
  operationId: string;
  providers: ApiKeyProvider[];
}
export function parseTeamBootstrap(input: unknown): TeamBootstrap {
  const row = modelObject(input);
  if (
    Object.keys(row).some((key) => !['teamId', 'operationId', 'providers'].includes(key)) ||
    !Array.isArray(row.providers) ||
    row.providers.length > 15 ||
    row.providers.some(
      (provider) =>
        typeof provider !== 'string' || !Object.hasOwn(OPENCLAW_PROVIDER_SETUP, provider),
    ) ||
    new Set(row.providers).size !== row.providers.length
  )
    throw new Error('Invalid fresh team bootstrap');
  return {
    teamId: teamId(row.teamId),
    operationId: teamId(row.operationId),
    providers: [...row.providers].sort() as ApiKeyProvider[],
  };
}
export function teamProviderParameters(name: string, input: TeamBootstrap) {
  return parseTeamBootstrap(input).providers.map((provider) => ({
    provider,
    parameter: getApiKeyParamName(name, provider),
    ...OPENCLAW_PROVIDER_SETUP[provider],
  }));
}
