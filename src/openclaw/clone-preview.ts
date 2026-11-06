import { createHash } from 'node:crypto';
import { object, parseMembers, textField } from './backup-contract.js';
import {
  planCloneContent,
  type CloneContentPlan,
  type CloneFile,
  type CloneSharedSkills,
} from './clone-content.js';
import { readCloneSourcePolicy } from './clone-source.js';
import type { RestoreAssetMove } from './restore-layout.js';
import type { CloneSourcePolicy } from './clone-policy.js';

type PreviewFile = Omit<CloneFile, 'source'>;
type PreviewSkills = Omit<CloneSharedSkills, 'files'> & { files: PreviewFile[] };
export interface ClonePreview {
  schemaVersion: 1;
  scope: 'whole-team-knowledge';
  content: Omit<CloneContentPlan, 'members' | 'sharedSkills'> & {
    members: (Omit<CloneContentPlan['members'][number], 'files' | 'workshopSkills'> & {
      files: PreviewFile[];
      workshopSkills?: PreviewSkills;
    })[];
    sharedSkills?: PreviewSkills;
  };
  policy: CloneSourcePolicy;
  policyDigest: string;
  providersInUse: string[];
}

export interface ClonePreviewRequest {
  schemaVersion: 1;
  configurationPath: string;
  members: Parameters<typeof planCloneContent>[0]['members'];
  moves: RestoreAssetMove[];
  stagingDirectory: string;
  nativePackageJson: string;
}
export function parseClonePreviewRequest(value: unknown): ClonePreviewRequest {
  const row = object(value);
  if (
    row.schemaVersion !== 1 ||
    row.configurationPath !== '/home/ubuntu/.openclaw/openclaw.json' ||
    !Array.isArray(row.moves) ||
    row.moves.length > 4096
  )
    throw new Error('Unsupported whole-team clone preview request');
  return {
    schemaVersion: 1,
    configurationPath: row.configurationPath,
    members: parseMembers(row.members),
    stagingDirectory: textField(row.stagingDirectory),
    nativePackageJson: textField(row.nativePackageJson),
    moves: row.moves.map((value) => {
      const move = object(value);
      return { source: textField(move.source), destination: textField(move.destination) };
    }),
  };
}
export const clonePolicyDigest = (policy: CloneSourcePolicy) =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex');

/** Read-only preview. Return no physical staging paths or source secret values. */
export async function previewCloneStaging(
  input: ClonePreviewRequest,
  signal?: AbortSignal,
): Promise<ClonePreview> {
  const request = parseClonePreviewRequest(input);
  const policy = await readCloneSourcePolicy({ ...request, signal });
  const content = await planCloneContent({
    ...request,
    credentialPaths: policy.credentialPaths,
    signal,
  });
  const files = (input: CloneFile[]) =>
    input.map(({ path, bytes, sha256, executable }) => ({
      path,
      bytes,
      sha256,
      ...(executable ? { executable } : {}),
    }));
  const skills = (input: CloneSharedSkills): PreviewSkills => ({
    root: input.root,
    files: files(input.files),
    omitted: input.omitted,
  });
  const providers = new Set<string>();
  const addReference = (ref: string | undefined, models = policy.models ?? {}) => {
    if (!ref) return;
    const resolved = Object.hasOwn(models, ref)
      ? ref
      : (Object.entries(models).find(([, settings]) => settings.alias === ref)?.[0] ?? ref);
    if (resolved?.includes('/')) providers.add(resolved.split('/')[0]);
  };
  for (const ref of [policy.model?.primary, ...(policy.model?.fallbacks ?? [])]) addReference(ref);
  for (const member of content.members) addReference(member.model);
  for (const agent of policy.agents)
    for (const ref of [agent.model?.primary, ...(agent.model?.fallbacks ?? [])])
      addReference(ref, { ...policy.models, ...agent.models });
  return {
    schemaVersion: 1,
    scope: 'whole-team-knowledge',
    policy,
    policyDigest: clonePolicyDigest(policy),
    providersInUse: [...providers].sort(),
    content: {
      schemaVersion: 1,
      digest: content.digest,
      members: content.members.map((member) => ({
        ...member,
        files: files(member.files),
        ...(member.workshopSkills ? { workshopSkills: skills(member.workshopSkills) } : {}),
      })),
      ...(content.sharedSkills ? { sharedSkills: skills(content.sharedSkills) } : {}),
    },
  };
}
