import { describe, expect, it } from 'vitest';
import { parseModelResult } from '../../src/openclaw/model-result.js';
import { modelJob } from '../helpers/model-operation.js';
const header = {
  ok: true,
  schemaVersion: 1,
  operationId: modelJob.operationId,
  stackId: modelJob.target.stackId,
  instanceId: modelJob.target.instanceId,
};
const observed = {
  scope: modelJob.scope,
  configHash: 'opaque:revision:1',
  configuredPrimary: 'openrouter/new',
  fallbackCount: 1,
  effectiveForNewSessions: 'openrouter/new',
  inherited: false,
  reloadOff: false,
  checkedAt: new Date().toISOString(),
  sessionSelections: 'preserved',
  inferenceVerified: false,
};
describe('bounded public model results', () => {
  it('accepts current observations, verified changes and explicit read-only reconciliation', () => {
    const current = { ...modelJob, action: { kind: 'current' as const } };
    expect(
      parseModelResult({ ...header, phase: 'observed', ...observed }, current, 'execute'),
    ).toMatchObject({ phase: 'observed' });
    expect(
      parseModelResult(
        { ...header, phase: 'complete', ...observed, maintenanceHeld: false, restarted: false },
        modelJob,
        'execute',
      ),
    ).toMatchObject({ phase: 'complete' });
    expect(
      parseModelResult(
        {
          ...header,
          phase: 'uncertain',
          maintenanceHeld: true,
          recordedAt: observed.checkedAt,
          observed: null,
          replayAllowed: false,
        },
        modelJob,
        'inspect',
      ),
    ).toMatchObject({ observed: null });
    expect(
      parseModelResult(
        {
          ...header,
          phase: 'not-recorded',
          maintenanceHeld: null,
          recordedAt: null,
          observed: null,
          replayAllowed: false,
        },
        modelJob,
        'inspect',
      ),
    ).toMatchObject({ phase: 'not-recorded', maintenanceHeld: null });
    expect(
      parseModelResult(
        {
          ...header,
          phase: 'complete',
          maintenanceHeld: false,
          reconciled: true,
          observed,
          replayAllowed: false,
        },
        modelJob,
        'accept-requested',
      ),
    ).toMatchObject({ reconciled: true });
  });
  it('rejects raw native fields, foreign identity/scope, missing readback, false inference claims and unconfirmed mutation results', () => {
    const good = {
      ...header,
      phase: 'complete',
      ...observed,
      maintenanceHeld: false,
      restarted: false,
    };
    for (const bad of [
      { ...good, nativeAuth: 'must-not-publish' },
      { ...good, scope: { kind: 'agent', agentId: 'other' } },
      { ...good, operationId: 'other' },
      { ...good, instanceId: 'i-fffffffffffffffff' },
      { ...good, effectiveForNewSessions: 'openrouter/other' },
      { ...good, inferenceVerified: true },
      { ...good, maintenanceHeld: true },
      { ...good, configuredPrimary: null },
    ])
      expect(() => parseModelResult(bad, modelJob, 'execute')).toThrow();
    expect(() =>
      parseModelResult(
        {
          ...header,
          phase: 'complete',
          maintenanceHeld: false,
          reconciled: true,
          observed: { ...observed, effectiveForNewSessions: 'openrouter/other' },
          replayAllowed: false,
        },
        modelJob,
        'accept-requested',
      ),
    ).toThrow(/requested model/);
    expect(() =>
      parseModelResult(
        {
          ...header,
          phase: 'uncertain',
          maintenanceHeld: true,
          message: 'private',
          inferenceVerified: false,
          replayAllowed: true,
        },
        modelJob,
        'execute',
      ),
    ).toThrow();
    expect(() =>
      parseModelResult(
        {
          ...header,
          phase: 'complete',
          maintenanceHeld: false,
          recordedAt: null,
          observed: null,
          replayAllowed: false,
        },
        modelJob,
        'inspect',
      ),
    ).toThrow();
    expect(() =>
      parseModelResult(
        {
          ...header,
          phase: 'complete',
          maintenanceHeld: false,
          recordedAt: observed.checkedAt,
          observed: { ...observed, rawConfig: 'must-not-publish' },
          replayAllowed: false,
        },
        modelJob,
        'inspect',
      ),
    ).toThrow();
  });
  it('validates catalog owner, provider, counts and continuation without accepting a truncated/private inventory', () => {
    const job = {
      ...modelJob,
      action: { kind: 'list' as const, provider: 'openrouter', offset: 0, limit: 20 },
    };
    const result = {
      ...header,
      phase: 'observed',
      scope: job.scope,
      catalogAgentId: 'researcher',
      models: [{ model: 'openrouter/new', available: true }],
      total: 2,
      nextOffset: 1,
      checkedAt: observed.checkedAt,
      pendingProviders: [],
      refreshRequested: false,
      inferenceVerified: false,
    };
    expect(parseModelResult(result, job, 'execute')).toMatchObject({ nextOffset: 1 });
    for (const bad of [
      { ...result, nextOffset: null },
      { ...result, nextOffset: 0 },
      { ...result, catalogAgentId: 'other' },
      { ...result, models: [{ model: 'anthropic/other' }] },
      { ...result, models: [{ model: 'openrouter/new', apiKey: 'must-not-publish' }] },
      { ...result, total: 0 },
      { ...result, refreshRequested: true },
    ])
      expect(() => parseModelResult(bad, job, 'execute')).toThrow();
  });
});
