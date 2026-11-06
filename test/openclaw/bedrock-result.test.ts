import { describe, it, expect } from 'vitest';
import { parseBedrockResult } from '../../src/openclaw/bedrock-result.js';
import { bedrockJob } from '../helpers/bedrock-operation.js';
const header = {
  ok: true,
  kind: bedrockJob.kind,
  operationId: bedrockJob.operationId,
  target: bedrockJob.target,
  inferenceRegion: bedrockJob.inferenceRegion,
  inferenceVerified: false,
  replayAllowed: false,
};
const observed = {
  configHash: 'opaque-native-revision',
  configured: true,
  pluginVerified: true,
  roleEnvironmentVerified: true,
  checkedAt: new Date().toISOString(),
};
const complete = {
  ...header,
  phase: 'complete',
  maintenanceHeld: false,
  observed,
  discovery: {
    ready: true,
    visibleModels: 2,
    checkedAt: new Date().toISOString(),
    inferenceVerified: false,
  },
};
describe('bounded Bedrock response projection', () => {
  it('accepts verified completion and keeps historic completion separate from unavailable live state', () => {
    expect(parseBedrockResult(complete, bedrockJob, 'execute')).toMatchObject({
      phase: 'complete',
      inferenceVerified: false,
    });
    expect(
      parseBedrockResult(
        {
          ...header,
          phase: 'complete',
          maintenanceHeld: false,
          recordedAt: new Date().toISOString(),
          observed: null,
        },
        bedrockJob,
        'inspect',
      ),
    ).toMatchObject({ phase: 'complete', observed: null });
  });
  it('rejects private fields, another host, inferred readiness and held completion', () => {
    for (const value of [
      { ...complete, config: { privateToken: 'must-not-publish' } },
      { ...complete, target: { ...bedrockJob.target, account: '999999999999' } },
      { ...complete, inferenceVerified: true },
      { ...complete, maintenanceHeld: true },
      { ...complete, observed: { ...observed, pluginVerified: false } },
      { ...complete, discovery: undefined },
    ])
      expect(() => parseBedrockResult(value, bedrockJob, 'execute')).toThrow();
    expect(() =>
      parseBedrockResult(
        { ...complete, observed: { ...observed, auth: { token: 'private' } } },
        bedrockJob,
        'execute',
      ),
    ).toThrow(/private fields/);
  });
  it('requires explicit no-write cancellation receipts for previous-state acceptance', () => {
    expect(
      parseBedrockResult(
        {
          ...header,
          phase: 'unchanged',
          maintenanceHeld: false,
          reconciled: true,
          message: 'Original revision fenced',
        },
        bedrockJob,
        'accept-previous',
      ),
    ).toMatchObject({ phase: 'unchanged', reconciled: true });
    expect(() => parseBedrockResult(complete, bedrockJob, 'accept-previous')).toThrow();
  });
  it('requires an explicit terminal abort receipt with released ownership', () => {
    const aborted = { ...header, phase: 'aborted', maintenanceHeld: false, reconciled: true };
    expect(parseBedrockResult(aborted, bedrockJob, 'abort').phase).toBe('aborted');
    for (const response of [
      complete,
      { ...aborted, reconciled: false },
      { ...aborted, maintenanceHeld: true },
    ])
      expect(() => parseBedrockResult(response, bedrockJob, 'abort')).toThrow();
    expect(() => parseBedrockResult(aborted, bedrockJob, 'accept-configured')).toThrow();
    expect(() =>
      parseBedrockResult({ ...aborted, reconciled: undefined }, bedrockJob, 'execute'),
    ).toThrow();
  });
});
