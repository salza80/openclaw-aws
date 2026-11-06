import { createHash } from 'node:crypto';
import { validAwsRegion } from '../aws/regions.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import { nativeModelReference, nativeModelScope, type ModelScope } from './model-control.js';

export interface ModelHostTarget {
  deploymentName: string;
  stackId: string;
  instanceId: string;
  roleId: string;
  account: string;
  region: string;
}
export type ModelAction =
  | { kind: 'current' }
  | { kind: 'list'; provider?: string; offset: number; limit: number }
  | { kind: 'set'; model: string; expectedHash: string; allowRestart: boolean };
export interface ModelJob {
  schemaVersion: 1;
  operationId: string;
  target: ModelHostTarget;
  scope: ModelScope;
  action: ModelAction;
  /** Deployment region for the already configured managed role environment.
   * This is never an instruction to install/enable a provider or change IAM. */
  bedrockRole: boolean;
  runtime: { openclaw: string; node: string };
}
export function modelObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid structured model operation');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Model operation contains unsupported fields');
}
export function modelText(value: unknown, maximum = 2048): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Invalid model operation text');
  return value;
}
export function parseModelJob(value: unknown): ModelJob {
  const row = modelObject(value);
  exact(row, [
    'schemaVersion',
    'operationId',
    'target',
    'scope',
    'action',
    'bedrockRole',
    'runtime',
  ]);
  if (row.schemaVersion !== 1 || typeof row.bedrockRole !== 'boolean')
    throw new Error('Invalid model operation version/auth mode');
  const operationId = modelText(row.operationId, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
    throw new Error('Model operation requires a UUID');
  const target = modelObject(row.target);
  exact(target, ['deploymentName', 'stackId', 'instanceId', 'roleId', 'account', 'region']);
  const deploymentName = modelText(target.deploymentName, 50);
  const account = modelText(target.account, 12);
  const region = modelText(target.region, 64);
  const stackId = modelText(target.stackId);
  const instanceId = modelText(target.instanceId, 32);
  const roleId = modelText(target.roleId, 128);
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(deploymentName) ||
    !/^\d{12}$/.test(account) ||
    !validAwsRegion(region) ||
    !new RegExp(
      `^arn:(aws|aws-us-gov|aws-cn):cloudformation:${region}:${account}:stack/OpenclawStack-${deploymentName}/[A-Za-z0-9-]+$`,
    ).test(stackId) ||
    !/^i-[a-f0-9]{8,17}$/.test(instanceId) ||
    !/^AROA[A-Z0-9]{12,124}$/.test(roleId)
  )
    throw new Error('Model operation does not identify a supported immutable AWS host');
  const scope = modelObject(row.scope);
  exact(scope, scope.kind === 'default' ? ['kind'] : ['kind', 'agentId']);
  const parsedScope = nativeModelScope(scope as unknown as ModelScope);
  const runtime = modelObject(row.runtime);
  exact(runtime, ['openclaw', 'node']);
  if (runtime.openclaw !== OPENCLAW_VERSION || runtime.node !== OPENCLAW_NODE_VERSION)
    throw new Error('Model operation requires the supported pinned native runtime');
  const action = modelObject(row.action);
  let parsedAction: ModelAction;
  if (action.kind === 'current') {
    exact(action, ['kind']);
    parsedAction = { kind: 'current' };
  } else if (action.kind === 'list') {
    exact(action, ['kind', 'provider', 'offset', 'limit']);
    const provider = action.provider === undefined ? undefined : modelText(action.provider, 128);
    if (
      (provider !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(provider)) ||
      !Number.isSafeInteger(action.offset) ||
      (action.offset as number) < 0 ||
      !Number.isSafeInteger(action.limit) ||
      (action.limit as number) < 1 ||
      (action.limit as number) > 50
    )
      throw new Error('Model inventory needs a bounded page and native provider ID');
    parsedAction = {
      kind: 'list',
      ...(provider ? { provider } : {}),
      offset: action.offset as number,
      limit: action.limit as number,
    };
  } else if (action.kind === 'set') {
    exact(action, ['kind', 'model', 'expectedHash', 'allowRestart']);
    if (typeof action.allowRestart !== 'boolean')
      throw new Error('Restart consent must be explicit');
    parsedAction = {
      kind: 'set',
      model: nativeModelReference(action.model),
      expectedHash: modelText(action.expectedHash),
      allowRestart: action.allowRestart,
    };
  } else throw new Error('Unsupported model operation');
  return {
    schemaVersion: 1,
    operationId,
    target: { deploymentName, stackId, instanceId, roleId, account, region },
    scope: parsedScope,
    action: parsedAction,
    bedrockRole: row.bedrockRole,
    runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
  };
}
export const modelJobDigest = (job: ModelJob) =>
  createHash('sha256')
    .update(JSON.stringify(parseModelJob(job)))
    .digest('hex');
