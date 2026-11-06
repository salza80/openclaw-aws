import { createHash } from 'node:crypto';
import { validAwsRegion } from '../aws/regions.js';
import { BEDROCK_PLUGIN } from './bedrock-configuration.js';
import {
  modelObject,
  modelText,
  parseModelHostTarget,
  parseModelRuntime,
  type ModelHostTarget,
  type ModelJob,
} from './model-contract.js';

export interface BedrockJob {
  schemaVersion: 1;
  kind: 'bedrock-connection';
  operationId: string;
  target: ModelHostTarget;
  runtime: ModelJob['runtime'];
  inferenceRegion: string;
  expectedHash: string;
  allowRestart: boolean;
  acceptPluginCapabilities: boolean;
  plugin: typeof BEDROCK_PLUGIN;
}
export type BedrockWorkerMode =
  'preview' | 'execute' | 'inspect' | 'accept-configured' | 'accept-previous';
export function parseBedrockJob(input: unknown): BedrockJob {
  const row = modelObject(input);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'bedrock-connection' ||
    Object.keys(row).some(
      (key) =>
        ![
          'schemaVersion',
          'kind',
          'operationId',
          'target',
          'runtime',
          'inferenceRegion',
          'expectedHash',
          'allowRestart',
          'acceptPluginCapabilities',
          'plugin',
        ].includes(key),
    ) ||
    typeof row.allowRestart !== 'boolean' ||
    typeof row.acceptPluginCapabilities !== 'boolean' ||
    typeof row.inferenceRegion !== 'string' ||
    !validAwsRegion(row.inferenceRegion)
  )
    throw new Error('Invalid Bedrock connection operation');
  const operationId = modelText(row.operationId, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
    throw new Error('Bedrock operation requires a UUID');
  const plugin = modelObject(row.plugin);
  if (
    Object.keys(plugin).length !== 3 ||
    Object.entries(BEDROCK_PLUGIN).some(([key, value]) => plugin[key] !== value)
  )
    throw new Error('Bedrock operation requires the exact reviewed official plugin');
  return {
    schemaVersion: 1,
    kind: 'bedrock-connection',
    operationId,
    target: parseModelHostTarget(row.target),
    runtime: parseModelRuntime(row.runtime),
    inferenceRegion: row.inferenceRegion,
    expectedHash: modelText(row.expectedHash),
    allowRestart: row.allowRestart,
    acceptPluginCapabilities: row.acceptPluginCapabilities,
    plugin: { ...BEDROCK_PLUGIN },
  };
}
export const bedrockJobDigest = (job: BedrockJob) =>
  createHash('sha256')
    .update(JSON.stringify(parseBedrockJob(job)))
    .digest('hex');
