import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from '../cli/utils/aws-clients.js';
import { isApiKeyProvider } from '../openclaw/connections.js';
import type { ApiKeyProvider } from '../cli/types/index.js';
import type { AwsLocation } from '../aws/target.js';

export interface CredentialReference {
  provider: string;
  kind: 'env' | 'ssm';
  reference: string;
}
/** Values remain in the calling backend and never enter a plan or journal. */
export async function resolveCredentialReferences(
  references: CredentialReference[],
  target: AwsLocation,
) {
  const credentials: Partial<Record<ApiKeyProvider, string>> = {};
  const client = createSsmClient(target);
  try {
    for (const reference of references) {
      if (!isApiKeyProvider(reference.provider) || Object.hasOwn(credentials, reference.provider))
        throw new Error('Unsupported or duplicate provider credential reference');
      let value: string | undefined;
      if (reference.kind === 'env') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.reference))
          throw new Error('Invalid credential environment reference');
        value = process.env[reference.reference];
      } else {
        try {
          const response = await client.send(
            new GetParameterCommand({ Name: reference.reference, WithDecryption: true }),
            { abortSignal: AbortSignal.timeout(30000) },
          );
          const selected = /^(.*):([1-9][0-9]*)$/.exec(reference.reference);
          if (
            response.Parameter?.Name === (selected?.[1] ?? reference.reference) &&
            response.Parameter.Type === 'SecureString' &&
            (!selected ||
              (Number.isSafeInteger(Number(selected[2])) &&
                response.Parameter.Version === Number(selected[2])))
          )
            value = response.Parameter.Value;
        } catch {
          throw new Error(
            `Provider credential could not be resolved privately: ${reference.provider}`,
          );
        }
      }
      if (!value?.trim() || value.length > 16384 || /[\r\n\0]/.test(value))
        throw new Error(`Provider credential is missing or unsupported: ${reference.provider}`);
      credentials[reference.provider] = value;
    }
    return credentials;
  } finally {
    client.destroy();
  }
}
