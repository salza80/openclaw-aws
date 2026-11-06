import { modelJob } from './model-operation.js';
import { BEDROCK_PLUGIN } from '../../src/openclaw/bedrock-configuration.js';
import type { BedrockJob } from '../../src/openclaw/bedrock-contract.js';
export const bedrockJob: BedrockJob = {
  schemaVersion: 1,
  kind: 'bedrock-connection',
  operationId: modelJob.operationId,
  target: modelJob.target,
  runtime: modelJob.runtime,
  inferenceRegion: 'eu-central-1',
  expectedHash: 'preview-revision',
  allowRestart: true,
  acceptPluginCapabilities: true,
  plugin: { ...BEDROCK_PLUGIN },
};
