import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ root: '', execute: vi.fn() }));
vi.mock('../../src/cli/utils/config.js', () => ({ getConfigRoot: () => mocks.root }));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: mocks.execute }));
import {
  assertDeploymentTarget,
  loadDeploymentState,
  observeRuntime,
  recordDeploymentState,
} from '../../src/operations/state.js';
import { withDeploymentLock, type DeploymentLease } from '../../src/operations/lock.js';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const status = {
  stackName: 'OpenclawStack-alpha',
  stackStatus: 'CREATE_COMPLETE',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/OpenclawStack-alpha/identity',
};
beforeEach(() => {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-state-'));
});
afterEach(() => {
  fs.rmSync(mocks.root, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe('deployment identity and native observations', () => {
  it('lets archive compose backup under one live lease without reacquiring its own lock', async () => {
    const ctx = makeCommandContext();
    let saved: DeploymentLease | undefined;
    await withDeploymentLock(ctx, async (lease) => {
      saved = lease;
      await expect(
        withDeploymentLock(ctx, async (nested) => nested === lease, lease),
      ).resolves.toBe(true);
      const other = { ...ctx, config: { ...ctx.config, stack: { name: 'OtherStack' } } };
      await expect(withDeploymentLock(other, async () => 'wrong', lease)).rejects.toThrow(
        /another target/,
      );
    });
    await expect(withDeploymentLock(ctx, async () => 'expired', saved)).rejects.toThrow(/expired/);
    await expect(
      withDeploymentLock(ctx, async () => 'forged', { deployment: saved!.deployment }),
    ).rejects.toThrow(/expired/);
    expect(fs.readdirSync(path.join(mocks.root, 'locks'))).toEqual([]);
  });
  it('records a confirmed Bedrock connection separately from original API credentials and resets it for a new identity', () => {
    const ctx = makeCommandContext();
    ctx.config.openclaw = { apiProvider: 'openrouter-api-key', model: 'openrouter/initial' };
    const original = recordDeploymentState(ctx, status, { newlyCreated: true });
    const connection = {
      authMode: 'instance-role' as const,
      inferenceRegion: 'eu-central-1',
      operationId: '11111111-1111-1111-1111-111111111111',
      checkedAt: new Date().toISOString(),
    };
    const updated = recordDeploymentState(ctx, status, { bedrockConnection: connection });
    expect(updated.desired).toEqual(original.desired);
    expect(updated.bedrockConnection).toEqual(connection);
    expect(ctx.config.openclaw.apiProvider).toBe('openrouter-api-key');
    expect(
      recordDeploymentState(ctx, status, {
        observed: {
          version: original.desired.version,
          model: 'openrouter/native',
          checkedAt: connection.checkedAt,
        },
      }).bedrockConnection,
    ).toEqual(connection);
    expect(
      recordDeploymentState(ctx, status, { newlyCreated: true }).bedrockConnection,
    ).toBeUndefined();
  });
  it('records explicit global/agent model intent without changing initial credential provenance or adopting later native drift', () => {
    const ctx = makeCommandContext();
    ctx.config.openclaw = { apiProvider: 'openrouter-api-key', model: 'openrouter/initial' };
    const original = recordDeploymentState(ctx, status, { newlyCreated: true });
    const checkedAt = new Date().toISOString();
    const operationId = '11111111-1111-1111-1111-111111111111';
    recordDeploymentState(ctx, status, {
      modelSelection: {
        scope: { kind: 'default' },
        model: 'amazon-bedrock/example-profile',
        operationId,
        checkedAt,
      },
    });
    recordDeploymentState(ctx, status, {
      modelSelection: {
        scope: { kind: 'agent', agentId: 'researcher' },
        model: 'openrouter/research',
        operationId,
        checkedAt,
      },
    });
    const saved = recordDeploymentState(ctx, status, {
      observed: {
        version: original.desired.version,
        model: 'openrouter/native-ui-choice',
        checkedAt,
      },
    });
    expect(saved.desired).toEqual(original.desired);
    expect(saved.modelSelections?.default?.model).toBe('amazon-bedrock/example-profile');
    expect(saved.modelSelections?.agents.researcher.model).toBe('openrouter/research');
    expect(saved.observed?.model).toBe('openrouter/native-ui-choice');
    expect(ctx.config.openclaw).toEqual({
      apiProvider: 'openrouter-api-key',
      model: 'openrouter/initial',
    });
    expect(
      recordDeploymentState(ctx, status, { newlyCreated: true }).modelSelections,
    ).toBeUndefined();
  });
  it('rejects malformed selection metadata before replacing a valid deployment record', () => {
    const ctx = makeCommandContext();
    recordDeploymentState(ctx, status);
    const before = loadDeploymentState(ctx);
    expect(() =>
      recordDeploymentState(ctx, status, {
        modelSelection: {
          scope: { kind: 'agent', agentId: '__proto__' },
          model: 'openrouter/model',
          operationId: '11111111-1111-1111-1111-111111111111',
          checkedAt: new Date().toISOString(),
        },
      }),
    ).toThrow();
    expect(loadDeploymentState(ctx)).toEqual(before);
  });
  it('records desired state separately from observed UI/model changes without modifying configuration', () => {
    const ctx = makeCommandContext();
    const before = JSON.stringify(ctx.config);
    const original = recordDeploymentState(ctx, status, { newlyCreated: true });
    const observed = {
      version: '2026.11.2',
      model: 'openrouter/openai/gpt-4.1-nano',
      checkedAt: new Date().toISOString(),
    };
    const updated = recordDeploymentState(ctx, status, { observed });
    expect(updated.desired).toEqual(original.desired);
    expect(updated.observed).toEqual(observed);
    expect(JSON.stringify(ctx.config)).toBe(before);
    expect(loadDeploymentState(ctx)).toEqual(updated);
    expect(fs.statSync(path.join(mocks.root, 'deployments/alpha.json')).mode & 0o777).toBe(0o600);
  });
  it('retains restore lineage and native model intent without inventing a provider', () => {
    const ctx = makeCommandContext();
    const lineage = {
      operationId: '11111111-1111-1111-1111-111111111111',
      pointId: '22222222-2222-2222-2222-222222222222',
    };
    const restored = recordDeploymentState(ctx, status, { restoredFrom: lineage });
    expect(restored.restoredFrom).toEqual(lineage);
    expect(restored.desired.provider).toBe('native-restored');
    expect(recordDeploymentState(ctx, status).restoredFrom).toEqual(lineage);
  });
  it('records independent clone lineage without claiming source identity was restored and retains it on inspection', () => {
    const ctx = makeCommandContext();
    const lineage = {
      operationId: '11111111-1111-1111-1111-111111111111',
      pointId: '22222222-2222-2222-2222-222222222222',
    };
    const cloned = recordDeploymentState(ctx, status, { newlyCreated: true, clonedFrom: lineage });
    expect(cloned.clonedFrom).toEqual(lineage);
    expect(cloned.restoredFrom).toBeUndefined();
    expect(cloned.desired.provider).toBe('native-cloned');
    expect(recordDeploymentState(ctx, status).clonedFrom).toEqual(lineage);
    expect(() =>
      recordDeploymentState(ctx, status, { clonedFrom: lineage, restoredFrom: lineage }),
    ).toThrow('both');
    expect(() =>
      recordDeploymentState(ctx, status, { clonedFrom: { ...lineage, operationId: 'invalid' } }),
    ).toThrow('UUIDs');
    expect(loadDeploymentState(ctx)?.clonedFrom).toEqual(lineage);
  });
  it('rejects mismatched or missing AWS identity without replacing the saved receipt', () => {
    const ctx = makeCommandContext();
    recordDeploymentState(ctx, status);
    expect(() => recordDeploymentState(ctx, { ...status, stackId: undefined })).toThrow('identity');
    expect(() =>
      recordDeploymentState(ctx, {
        ...status,
        stackId: status.stackId.replace('123456789012', '999999999999'),
      }),
    ).toThrow('identity');
    expect(() =>
      recordDeploymentState(ctx, { ...status, stackId: status.stackId + '-replacement' }),
    ).toThrow('differs');
    expect(loadDeploymentState(ctx)?.identity.stackId).toBe(status.stackId);
    expect(
      recordDeploymentState(
        ctx,
        { ...status, stackId: status.stackId + '-replacement' },
        { newlyCreated: true },
      ).identity.stackId,
    ).toContain('replacement');
  });
  it('blocks retargeted credentials and replacement stacks before cleanup', () => {
    const ctx = makeCommandContext();
    recordDeploymentState(ctx, status);
    expect(() => assertDeploymentTarget(ctx, status)).not.toThrow();
    expect(() =>
      assertDeploymentTarget({
        ...ctx,
        config: { ...ctx.config, aws: { region: 'eu-central-1' } },
      }),
    ).toThrow('region does not match');
    expect(() =>
      assertDeploymentTarget({ ...ctx, target: { ...ctx.target, account: '999999999999' } }),
    ).toThrow('differs');
    expect(() =>
      assertDeploymentTarget(ctx, { ...status, stackId: status.stackId + '-new' }),
    ).toThrow('differs');
  });

  it('reads native structured data and keeps only safe version/model fields', async () => {
    mocks.execute.mockResolvedValue({
      stdout: JSON.stringify({
        version: '2026.11.1',
        model: 'openrouter/openai/gpt-4.1-nano',
        auth: 'private',
      }),
    });
    expect(await observeRuntime(makeCommandContext(), 'i-test')).toEqual({
      version: '2026.11.1',
      model: 'openrouter/openai/gpt-4.1-nano',
      checkedAt: expect.any(String),
    });
  });
  it.each([
    'partial-private-json',
    '{"version":"private"}',
    '{"version":"2026.11.1","model":null}',
  ])('fails closed on unsupported native results', async (stdout) => {
    mocks.execute.mockResolvedValue({ stdout });
    await expect(observeRuntime(makeCommandContext(), 'i-test')).rejects.toThrow();
  });
});
describe('per-deployment mutation locks', () => {
  it('serializes the same deployment, allows different targets, and releases after failure', async () => {
    const ctx = makeCommandContext();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withDeploymentLock(ctx, async () => {
      events.push('first');
      await gate;
      events.push('end-first');
    });
    const second = withDeploymentLock(ctx, async () => {
      events.push('second');
    });
    const other = withDeploymentLock(
      { ...ctx, target: { ...ctx.target, account: '999999999999' } },
      async () => {
        events.push('other');
      },
    );
    await other;
    expect(events).toEqual(['first', 'other']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'other', 'end-first', 'second']);
    await expect(
      withDeploymentLock(ctx, async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
    await expect(withDeploymentLock(ctx, async () => 'released')).resolves.toBe('released');
    expect(fs.readdirSync(path.join(mocks.root, 'locks'))).toEqual([]);
  });
});
