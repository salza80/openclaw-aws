import { open } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createSsmClient } from './aws-clients.js';
import { parseTeamDefinition, type TeamDefinition } from '../../openclaw/team-definition.js';
import type { AwsLocation } from '../../aws/target.js';
import type { ApiKeyProvider } from '../types/index.js';

export async function readTeamFile(filename: string): Promise<TeamDefinition> {
  const file = await open(filename, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error('Team definition must be a regular file under 64 KiB');
    const body = await file.readFile('utf8');
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Team definition exceeds 64 KiB');
    const document = parseDocument(body, { schema: 'core', uniqueKeys: true, version: '1.2' });
    if (document.errors.length || document.warnings.length)
      throw new Error('Invalid team YAML/JSON; inspect the selected file');
    return parseTeamDefinition(document.toJS({ maxAliasCount: 20 }));
  } finally {
    await file.close();
  }
}
export async function teamCredentials(definition: TeamDefinition, target: AwsLocation) {
  const credentials: Partial<Record<ApiKeyProvider, string>> = {};
  const client = createSsmClient(target);
  try {
    for (const reference of definition.credentials) {
      let value: string | undefined;
      if (reference.kind === 'env') value = process.env[reference.reference];
      else {
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
            `Team provider credential could not be resolved privately: ${reference.provider}`,
          );
        }
      }
      if (!value?.trim() || value.length > 16384 || /[\r\n\0]/.test(value))
        throw new Error(
          `Team provider credential is missing or unsupported: ${reference.provider}`,
        );
      credentials[reference.provider] = value;
    }
    return credentials;
  } finally {
    client.destroy();
  }
}
