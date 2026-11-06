import { isDeepStrictEqual } from 'node:util';
import { modelObject, modelText } from './model-contract.js';
import type { BedrockJob, BedrockWorkerMode } from './bedrock-contract.js';
import type { BedrockObservation } from './bedrock-worker.js';
import type { BedrockPhase } from './bedrock-journal.js';
export interface BedrockResult {
  kind: 'bedrock-connection';
  operationId: string;
  target: BedrockJob['target'];
  inferenceRegion: string;
  inferenceVerified: false;
  replayAllowed: false;
  phase: BedrockPhase | 'preview' | 'not-recorded';
  configHash?: string;
  unrelatedHash?: string;
  pluginInstalled?: boolean;
  maintenanceHeld?: boolean | null;
  recordedAt?: string | null;
  observed?: BedrockObservation | null;
  reconciled?: true;
  discovery?: { ready: true; visibleModels: number; checkedAt: string; inferenceVerified: false };
  message?: string;
}
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Bedrock response contains unsupported private fields');
};
const timestamp = (value: unknown) => {
  const text = modelText(value, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error('Invalid Bedrock observation time');
  return text;
};
function observation(input: unknown): BedrockObservation {
  const row = modelObject(input);
  exact(row, [
    'configHash',
    'configured',
    'pluginVerified',
    'roleEnvironmentVerified',
    'checkedAt',
  ]);
  if (
    typeof row.configured !== 'boolean' ||
    typeof row.pluginVerified !== 'boolean' ||
    typeof row.roleEnvironmentVerified !== 'boolean'
  )
    throw new Error('Invalid Bedrock observation');
  return {
    configHash: modelText(row.configHash),
    configured: row.configured,
    pluginVerified: row.pluginVerified,
    roleEnvironmentVerified: row.roleEnvironmentVerified,
    checkedAt: timestamp(row.checkedAt),
  };
}
export function parseBedrockResult(
  input: unknown,
  job: BedrockJob,
  mode: BedrockWorkerMode,
): BedrockResult {
  const row = modelObject(input);
  const common = [
    'ok',
    'kind',
    'operationId',
    'target',
    'inferenceRegion',
    'inferenceVerified',
    'replayAllowed',
    'phase',
  ];
  if (
    row.ok !== true ||
    row.kind !== job.kind ||
    row.operationId !== job.operationId ||
    !isDeepStrictEqual(row.target, job.target) ||
    row.inferenceRegion !== job.inferenceRegion ||
    row.inferenceVerified !== false ||
    row.replayAllowed !== false
  )
    throw new Error('Bedrock response identity differs from the selected request');
  const header = {
    kind: job.kind,
    operationId: job.operationId,
    target: job.target,
    inferenceRegion: job.inferenceRegion,
    inferenceVerified: false as const,
    replayAllowed: false as const,
  };
  if (mode === 'preview') {
    exact(row, [...common, 'configHash', 'unrelatedHash', 'pluginInstalled']);
    if (
      row.phase !== 'preview' ||
      typeof row.pluginInstalled !== 'boolean' ||
      typeof row.unrelatedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.unrelatedHash)
    )
      throw new Error('Invalid Bedrock preview');
    return {
      ...header,
      phase: 'preview',
      configHash: modelText(row.configHash),
      unrelatedHash: row.unrelatedHash,
      pluginInstalled: row.pluginInstalled,
    };
  }
  if (
    typeof row.phase !== 'string' ||
    ![
      'started',
      'preflight-ready',
      'plugin-intent',
      'plugin-ready',
      'environment-intent',
      'environment-ready',
      'config-intent',
      'config-acknowledged',
      'config-complete',
      'config-rolled-back',
      'config-uncertain',
      'discovery-intent',
      'complete',
      'rolled-back',
      'unchanged',
      'aborted',
      'uncertain',
      'not-recorded',
    ].includes(row.phase)
  )
    throw new Error('Invalid Bedrock operation phase');
  if (row.maintenanceHeld !== null && typeof row.maintenanceHeld !== 'boolean')
    throw new Error('Bedrock response omits maintenance ownership');
  const result: BedrockResult = {
    ...header,
    phase: row.phase as BedrockResult['phase'],
    maintenanceHeld: row.maintenanceHeld,
  };
  if (mode === 'inspect') {
    exact(row, [...common, 'maintenanceHeld', 'recordedAt', 'observed']);
    if (row.recordedAt === null && row.phase !== 'not-recorded')
      throw new Error('Bedrock history lacks its receipt time');
    result.recordedAt = row.recordedAt === null ? null : timestamp(row.recordedAt);
    result.observed = row.observed === null ? null : observation(row.observed);
    return result;
  }
  exact(row, [...common, 'maintenanceHeld', 'reconciled', 'observed', 'discovery', 'message']);
  if (!['complete', 'unchanged', 'rolled-back', 'uncertain', 'aborted'].includes(row.phase))
    throw new Error('Bedrock execution did not return an outcome');
  if (row.message !== undefined) result.message = modelText(row.message, 2048);
  if (row.observed !== undefined) result.observed = observation(row.observed);
  if (row.reconciled !== undefined) {
    if (
      row.reconciled !== true ||
      !['accept-configured', 'accept-previous', 'abort'].includes(mode)
    )
      throw new Error('Invalid Bedrock reconciliation');
    result.reconciled = true;
  }
  if (row.discovery !== undefined) {
    const discovery = modelObject(row.discovery);
    exact(discovery, ['ready', 'visibleModels', 'checkedAt', 'inferenceVerified']);
    if (
      discovery.ready !== true ||
      discovery.inferenceVerified !== false ||
      !Number.isSafeInteger(discovery.visibleModels) ||
      (discovery.visibleModels as number) < 0 ||
      (discovery.visibleModels as number) > 100000
    )
      throw new Error('Invalid Bedrock discovery receipt');
    result.discovery = {
      ready: true,
      visibleModels: discovery.visibleModels as number,
      checkedAt: timestamp(discovery.checkedAt),
      inferenceVerified: false,
    };
  }
  if (row.phase === 'complete') {
    if (
      row.maintenanceHeld !== false ||
      !result.observed?.configured ||
      !result.observed.pluginVerified ||
      !result.observed.roleEnvironmentVerified ||
      (mode === 'execute' && !result.discovery) ||
      (mode === 'accept-configured' && !result.reconciled)
    )
      throw new Error('Bedrock completion is not freshly verified');
  } else if (row.phase !== 'uncertain' && row.maintenanceHeld !== false)
    throw new Error('Terminal Bedrock refusal/rollback still holds maintenance');
  if (mode === 'accept-previous' && (row.phase !== 'unchanged' || row.reconciled !== true))
    throw new Error('Previous-state acceptance must fence an unchanged operation');
  if (mode === 'accept-configured' && (row.phase !== 'complete' || row.reconciled !== true))
    throw new Error('Configured-state acceptance must certify the configured connection');
  if (row.phase === 'aborted' && mode !== 'abort')
    throw new Error('Only an explicit abort can certify a stopped partial setup');
  if (mode === 'abort' && (row.phase !== 'aborted' || row.reconciled !== true))
    throw new Error('Bedrock abort must certify the original settings and release its own hold');
  return result;
}
