import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { BackupMember } from './backup-contract.js';

type SessionsSdk = typeof import('openclaw/plugin-sdk/session-store-runtime');
type ModelsSdk = typeof import('openclaw/plugin-sdk/model-session-runtime');

/** Read model references through the pinned public native resolver. Historical
 * conversations keep their selections when restored; no transcript or session
 * identity belongs in the portable permission intent. Caller owns quiescence. */
export async function recoverySessionModels(options: {
  nativePackageJson: string;
  config: Parameters<ModelsSdk['resolveSessionModelRef']>[0];
  members: BackupMember[];
}): Promise<string[]> {
  const require = createRequire(options.nativePackageJson);
  const sessions = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href
  )) as SessionsSdk;
  const models = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/model-session-runtime')).href
  )) as ModelsSdk;
  const references = new Set<string>();
  let count = 0;
  for (const member of options.members) {
    const entries = await sessions.listSessionEntriesAsync({
      agentId: member.id,
      storePath: path.join(member.agentDir, 'openclaw-agent.sqlite'),
      readConsistency: 'latest',
    });
    count += entries.length;
    if (count > 100000) throw new Error('Recovery session model inventory exceeds its bound');
    for (const { entry } of entries) {
      const resolved = models.resolveSessionModelRef(options.config, entry, member.id);
      if (resolved.provider === 'amazon-bedrock')
        references.add(`${resolved.provider}/${resolved.model}`);
      if (references.size > 256)
        throw new Error('Recovery session model route inventory exceeds its bound');
    }
  }
  return [...references].sort();
}
