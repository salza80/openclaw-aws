import { open } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { parseTeamDefinition, type TeamDefinition } from '../../openclaw/team-definition.js';
import type { AwsLocation } from '../../aws/target.js';
import { resolveCredentialReferences } from '../../operations/credential-references.js';

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
  return resolveCredentialReferences(definition.credentials, target);
}
