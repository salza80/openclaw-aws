import { modelObject, modelText } from '../openclaw/model-contract.js';
import { teamId } from '../openclaw/team-contract.js';
import { nativeModelReference, nativeModelScope } from '../openclaw/model-control.js';
import { parseTeamDefinition } from '../openclaw/team-definition.js';
import { isApiKeyProvider } from '../openclaw/connections.js';
import { parseVaultUri } from '../aws/recovery-store.js';
import { validAwsRegion } from '../aws/regions.js';
import { validateProjectName } from '../cli/utils/validation.js';
import type { UiAction, UiActionRequest, UiVaultReference } from './contracts.js';

export const uiActions: UiAction[] = [
  'create',
  'team-create',
  'start',
  'stop',
  'backup',
  'archive',
  'restore',
  'clone',
  'team-configure',
  'model-set',
  'bedrock-enable',
  'resume',
];
const actionFields: Record<UiAction, string[]> = {
  create: [
    'name',
    'region',
    'profile',
    'instanceType',
    'provider',
    'model',
    'bedrockRegion',
    'credentials',
  ],
  'team-create': [
    'name',
    'region',
    'profile',
    'instanceType',
    'provider',
    'model',
    'bedrockRegion',
    'credentials',
    'definition',
  ],
  start: ['name'],
  stop: ['name'],
  backup: ['name', 'vault'],
  archive: ['name', 'vault', 'keepConfig'],
  restore: [
    'name',
    'vault',
    'from',
    'region',
    'profile',
    'targetRegion',
    'targetProfile',
    'instanceType',
    'volumeGiB',
  ],
  clone: [
    'name',
    'vault',
    'from',
    'region',
    'profile',
    'targetRegion',
    'targetProfile',
    'instanceType',
    'volumeGiB',
    'provider',
    'bedrockRegion',
    'credentials',
  ],
  'team-configure': ['name', 'definition', 'allowRestart', 'teamId'],
  'model-set': ['name', 'agent', 'model', 'allowRestart'],
  'bedrock-enable': ['name', 'bedrockRegion', 'model', 'allowRestart'],
  resume: [
    'name',
    'operationId',
    'recoveryKind',
    'vault',
    'region',
    'profile',
    'accept',
    'activate',
  ],
};
export class UiInputError extends Error {}
const fail = () => {
  throw new UiInputError('Unsupported or incomplete operation input');
};
export function uiName(input: unknown) {
  const value = modelText(input, 50);
  if (validateProjectName(value) !== true) fail();
  return value;
}
const region = (value: unknown) => {
  const text = modelText(value, 64);
  if (!validAwsRegion(text)) fail();
  return text;
};
export function parseUiVault(input: unknown): UiVaultReference {
  const row = modelObject(input);
  if (Object.keys(row).some((key) => !['uri', 'region', 'profile'].includes(key))) fail();
  const uri = modelText(row.uri, 1024);
  parseVaultUri(uri);
  return {
    uri,
    region: region(row.region),
    ...(row.profile === undefined ? {} : { profile: modelText(row.profile, 128) }),
  };
}
export function parseUiActionRequest(input: unknown): UiActionRequest {
  try {
    const row = modelObject(input);
    if (!uiActions.includes(row.action as UiAction)) fail();
    const action = row.action as UiAction;
    if (Object.keys(row).some((key) => key !== 'action' && !actionFields[action].includes(key)))
      fail();
    const result: UiActionRequest = { action };
    if (row.name !== undefined) result.name = uiName(row.name);
    for (const key of ['region', 'targetRegion', 'bedrockRegion'] as const)
      if (row[key] !== undefined) result[key] = region(row[key]);
    for (const key of ['profile', 'targetProfile'] as const)
      if (row[key] !== undefined) result[key] = modelText(row[key], 128);
    if (row.instanceType !== undefined) {
      const value = modelText(row.instanceType, 64);
      if (!/^[a-z][0-9][a-z]?\.(?:nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/.test(value))
        fail();
      result.instanceType = value;
    }
    if (row.provider !== undefined) {
      if (row.provider !== 'amazon-bedrock' && !isApiKeyProvider(row.provider)) fail();
      result.provider = row.provider as string;
    }
    if (row.model !== undefined) result.model = nativeModelReference(row.model);
    if (row.agent !== undefined)
      result.agent = (
        nativeModelScope({ kind: 'agent', agentId: row.agent as string }) as { agentId: string }
      ).agentId;
    if (row.definition !== undefined) result.definition = parseTeamDefinition(row.definition);
    if (row.vault !== undefined) {
      result.vault = modelText(row.vault, 1024);
      parseVaultUri(result.vault);
    }
    for (const key of ['from', 'operationId', 'teamId'] as const)
      if (row[key] !== undefined) result[key] = teamId(row[key]);
    for (const key of ['allowRestart', 'keepConfig', 'activate'] as const)
      if (row[key] !== undefined) {
        if (typeof row[key] !== 'boolean') fail();
        result[key] = row[key] as boolean;
      }
    if (row.volumeGiB !== undefined) {
      if (
        !Number.isSafeInteger(row.volumeGiB) ||
        (row.volumeGiB as number) < 30 ||
        (row.volumeGiB as number) > 16384
      )
        fail();
      result.volumeGiB = row.volumeGiB as number;
    }
    if (row.recoveryKind !== undefined) {
      if (
        !['archive', 'restore', 'clone', 'team', 'model', 'bedrock'].includes(
          String(row.recoveryKind),
        )
      )
        fail();
      result.recoveryKind = row.recoveryKind as UiActionRequest['recoveryKind'];
    }
    if (row.accept !== undefined) {
      if (!['requested', 'previous', 'abort'].includes(String(row.accept))) fail();
      result.accept = row.accept as UiActionRequest['accept'];
    }
    if (row.credentials !== undefined) {
      if (!Array.isArray(row.credentials) || row.credentials.length > 16) fail();
      result.credentials = (row.credentials as unknown[]).map((input) => {
        const value = modelObject(input);
        if (
          Object.keys(value).some((key) => !['provider', 'kind', 'reference'].includes(key)) ||
          !isApiKeyProvider(value.provider) ||
          !['env', 'ssm'].includes(String(value.kind))
        )
          fail();
        const reference = modelText(value.reference, 1024);
        if (
          !(value.kind === 'env'
            ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)
            : /^\/[A-Za-z0-9_./-]+(?::[1-9][0-9]*)?$/.test(reference))
        )
          fail();
        return { provider: value.provider as string, kind: value.kind as 'env' | 'ssm', reference };
      });
      if (
        new Set(result.credentials.map((value) => value.provider)).size !==
        result.credentials.length
      )
        fail();
    }
    const required = (keys: (keyof UiActionRequest)[]) => {
      if (keys.some((key) => result[key] === undefined)) fail();
    };
    if (['create', 'team-create'].includes(action)) required(['name', 'region', 'provider']);
    if (
      [
        'start',
        'stop',
        'backup',
        'archive',
        'team-configure',
        'model-set',
        'bedrock-enable',
      ].includes(action)
    )
      required(['name']);
    if (['backup', 'archive'].includes(action)) required(['vault']);
    if (['team-create', 'team-configure'].includes(action)) required(['definition']);
    if (['model-set', 'bedrock-enable'].includes(action)) required(['model']);
    if (action === 'bedrock-enable') required(['bedrockRegion']);
    if (['restore', 'clone'].includes(action)) required(['vault', 'from', 'region']);
    if (action === 'clone') required(['name', 'provider']);
    if (action === 'resume') {
      required(['operationId', 'recoveryKind']);
      if (result.recoveryKind === 'archive') required(['vault', 'region']);
      if (['team', 'model', 'bedrock'].includes(result.recoveryKind ?? '')) required(['name']);
      if (
        result.accept !== undefined &&
        !(
          (result.recoveryKind === 'model' && result.accept !== 'abort') ||
          result.recoveryKind === 'bedrock' ||
          (['team', 'archive'].includes(result.recoveryKind ?? '') && result.accept === 'abort')
        )
      )
        fail();
    }
    return result;
  } catch (error) {
    throw new UiInputError('Unsupported or incomplete operation input', { cause: error });
  }
}
