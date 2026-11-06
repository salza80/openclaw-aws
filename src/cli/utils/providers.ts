import { API_PROVIDERS } from '../constants.js';
import type { Provider } from '../types/index.js';
import { ValidationError } from './errors.js';
export function providerChoice(value: string): Provider {
  if (value === 'bedrock' || value === 'amazon-bedrock') return 'amazon-bedrock';
  const provider = API_PROVIDERS.find(
    ({ value: candidate }) => candidate === value || candidate.replace(/-api-key$/, '') === value,
  )?.value;
  if (!provider)
    throw new ValidationError(`Unsupported provider '${value}'`, [
      'Choose a provider listed by openclaw-aws create/clone --help',
    ]);
  return provider;
}
