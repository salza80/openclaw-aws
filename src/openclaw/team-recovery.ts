import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  modelObject,
  modelText,
  parseModelHostTarget,
  type ModelHostTarget,
} from './model-contract.js';
import { teamId } from './team-contract.js';
import { teamNativeId, type TeamDefinition } from './team-definition.js';
import { privateModelJson, createPrivateControlRecord } from './model-journal.js';
import { assertDirectoryChain } from './restore-layout.js';
import type { BackupMember } from './backup-contract.js';

export interface TeamIdentity {
  id: string;
  coordinator: string;
  roles: { logicalId: string; nativeId: string; role: string }[];
}
export interface TeamRecovery extends TeamIdentity {
  policyDigest: string;
}
const nativeId = (input: unknown) => {
  const value = modelText(input, 64);
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ||
    ['constructor', '__proto__', 'prototype'].includes(value)
  )
    throw new Error('Invalid team role identity');
  return value;
};
export function parseTeamIdentity(input: unknown): TeamIdentity {
  const row = modelObject(input),
    id = teamId(row.id),
    coordinator = nativeId(row.coordinator);
  if (!Array.isArray(row.roles) || row.roles.length < 2 || row.roles.length > 16)
    throw new Error('Team identity requires its complete role mapping');
  const roles = row.roles
    .map((value) => {
      const role = modelObject(value);
      if (Object.keys(role).some((key) => !['logicalId', 'nativeId', 'role'].includes(key)))
        throw new Error('Unsupported team role metadata');
      return {
        logicalId: nativeId(role.logicalId),
        nativeId: nativeId(role.nativeId),
        role: modelText(role.role, 160),
      };
    })
    .sort((a, b) => (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0));
  if (
    new Set(roles.map((role) => role.logicalId)).size !== roles.length ||
    new Set(roles.map((role) => role.nativeId)).size !== roles.length ||
    !roles.some((role) => role.logicalId === coordinator && role.nativeId === 'main') ||
    roles.some((role) => role.logicalId !== coordinator && role.logicalId !== role.nativeId)
  )
    throw new Error('Team role mapping has conflicting ownership');
  return { id, coordinator, roles };
}
export function teamIdentity(id: string, definition: TeamDefinition): TeamIdentity {
  return parseTeamIdentity({
    id,
    coordinator: definition.coordinator,
    roles: definition.members.map((member) => ({
      logicalId: member.id,
      nativeId: teamNativeId(definition, member.id),
      role: member.role,
    })),
  });
}
export function parseTeamRecovery(input: unknown, members: BackupMember[]): TeamRecovery {
  const row = modelObject(input),
    identity = parseTeamIdentity(row);
  if (
    Object.keys(row).some((key) => !['id', 'coordinator', 'roles', 'policyDigest'].includes(key)) ||
    !/^[a-f0-9]{64}$/.test(modelText(row.policyDigest, 64)) ||
    !isDeepStrictEqual(
      identity.roles.map((role) => role.nativeId).sort(),
      members.map((member) => member.id).sort(),
    )
  )
    throw new Error('Team recovery metadata does not cover the complete native roster');
  return { ...identity, policyDigest: row.policyDigest as string };
}
/** Hash native authored coordination/model settings, never copy them into an
 * application policy or replay the original team definition after recovery. */
export function teamPolicyDigest(input: unknown) {
  const config = modelObject(input);
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : value;
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          agents: config.agents ?? {},
          tools: config.tools ?? {},
          bindings: config.bindings ?? [],
        }),
      ),
    )
    .digest('hex');
}
export async function publishTeamMembership(
  home: string,
  target: ModelHostTarget,
  input: TeamIdentity,
) {
  const identity = parseTeamIdentity(input),
    root = path.join(home, '.openclaw-aws');
  await assertDirectoryChain(root, home, true);
  const owner = { schemaVersion: 1, teamId: identity.id, target: parseModelHostTarget(target) };
  const ownership = path.join(root, 'team-owner.json');
  try {
    await createPrivateControlRecord(ownership, owner);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST' ||
      !isDeepStrictEqual(await privateModelJson(ownership), owner)
    )
      throw error;
  }
  const filename = path.join(root, 'team-members.json');
  try {
    const previous = await privateModelJson(filename);
    if (
      parseTeamIdentity(previous.identity).id !== identity.id ||
      !isDeepStrictEqual(previous.target, target)
    )
      throw new Error('Team membership metadata belongs to another host');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await createPrivateControlRecord(temporary, { schemaVersion: 1, target, identity });
    await rename(temporary, filename);
    const directory = await open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function captureTeamRecovery(
  home: string,
  source: Pick<ModelHostTarget, 'stackId' | 'instanceId' | 'roleId' | 'account' | 'region'>,
  members: BackupMember[],
  config: unknown,
): Promise<TeamRecovery | undefined> {
  let saved;
  try {
    saved = await privateModelJson(path.join(home, '.openclaw-aws/team-members.json'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      try {
        await privateModelJson(path.join(home, '.openclaw-aws/team-owner.json'));
      } catch (ownerError) {
        if (ownerError instanceof Error && 'code' in ownerError && ownerError.code === 'ENOENT')
          return undefined;
        throw ownerError;
      }
      throw new Error('Team recovery role mapping is missing; no ordinary backup may replace it', {
        cause: error,
      });
    }
    throw error;
  }
  const target = parseModelHostTarget(saved.target);
  const identity = parseTeamIdentity(saved.identity);
  const owner = await privateModelJson(path.join(home, '.openclaw-aws/team-owner.json'));
  if (!isDeepStrictEqual(owner, { schemaVersion: 1, teamId: identity.id, target }))
    throw new Error('Team recovery owner and role mapping differ');
  if (
    saved.schemaVersion !== 1 ||
    Object.entries(source).some(([key, value]) => target[key as keyof ModelHostTarget] !== value)
  )
    throw new Error('Team recovery ownership differs from this source');
  return parseTeamRecovery({ ...identity, policyDigest: teamPolicyDigest(config) }, members);
}
