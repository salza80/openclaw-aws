import type { Provider } from '../cli/types/index.js';
import { OPENCLAW_PROVIDER_SETUP } from './install.js';
export type ExplicitCloneCredentials = Partial<Record<Provider, string>>;
/** No ambient environment or archived credentials are candidates. */
export function explicitCloneCredentials(primary: Provider, values: ExplicitCloneCredentials) {
  if (!Object.hasOwn(OPENCLAW_PROVIDER_SETUP, primary) || !Object.hasOwn(values, primary))
    throw new Error('Clone requires explicit credentials for the selected target provider');
  for (const [provider, value] of Object.entries(values))
    if (
      !Object.hasOwn(OPENCLAW_PROVIDER_SETUP, provider) ||
      typeof value !== 'string' ||
      !value ||
      /[\0\r\n]/.test(value) ||
      Buffer.byteLength(value) > 4096
    )
      throw new Error('An explicit clone provider credential is unsupported');
  const providers = (Object.keys(OPENCLAW_PROVIDER_SETUP) as Provider[]).filter((provider) =>
    Object.hasOwn(values, provider),
  );
  return {
    providers,
    environment: Object.fromEntries(
      providers.map((provider) => [OPENCLAW_PROVIDER_SETUP[provider].envVar, values[provider]!]),
    ),
  };
}
