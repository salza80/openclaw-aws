import { mkdtemp, rm, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { bedrockJob } from '../helpers/bedrock-operation.js';
import { runBedrockOperation, type BedrockWorkerHost } from '../../src/openclaw/bedrock-worker.js';
import { bedrockHostJournal } from '../../src/openclaw/bedrock-journal.js';
import { modelHostJournal } from '../../src/openclaw/model-journal.js';
import { modelJob } from '../helpers/model-operation.js';
let home: string;
let host: BedrockWorkerHost;
let isConfigured: boolean;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'openclaw-bedrock-worker-'));
  isConfigured = false;
  host = {
    home,
    identify: vi.fn(async () => {}),
    preflight: vi.fn(async () => ({
      configHash: bedrockJob.expectedHash,
      unrelatedHash: 'a'.repeat(64),
      pluginInstalled: false,
    })),
    revision: vi.fn(async () => ({ configHash: 'plugin-revision', unrelatedHash: 'a'.repeat(64) })),
    installPlugin: vi.fn(async () => {}),
    prepareEnvironment: vi.fn(async () => {}),
    configure: vi.fn(async (_job, _revision, record, verify) => {
      await record({
        phase: 'intent',
        beforeHash: 'plugin-revision',
        inferenceRegion: 'eu-central-1',
      });
      isConfigured = true;
      await record({
        phase: 'acknowledged',
        beforeHash: 'plugin-revision',
        inferenceRegion: 'eu-central-1',
      });
      await verify();
      await record({
        phase: 'complete',
        beforeHash: 'plugin-revision',
        inferenceRegion: 'eu-central-1',
      });
    }),
    refresh: vi.fn(async () => ({
      ready: true,
      visibleModels: 2,
      checkedAt: new Date().toISOString(),
      inferenceVerified: false,
    })),
    observe: vi.fn(async () => ({
      configHash: 'live-revision',
      configured: isConfigured,
      pluginVerified: isConfigured,
      roleEnvironmentVerified: isConfigured,
      checkedAt: new Date().toISOString(),
    })),
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe('durable Bedrock provider lifecycle', () => {
  it('fences a never-started delivery only at its unchanged original native revision', async () => {
    vi.mocked(host.revision).mockResolvedValue({
      configHash: bedrockJob.expectedHash,
      unrelatedHash: 'a'.repeat(64),
    });
    expect(await runBedrockOperation(bedrockJob, host, 'accept-previous')).toMatchObject({
      phase: 'unchanged',
      maintenanceHeld: false,
      reconciled: true,
    });
    await expect(runBedrockOperation(bedrockJob, host)).rejects.toThrow(/already started/);
    expect(host.installPlugin).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
  });
  it('previews without a journal or provider mutation, then records every side-effect boundary and releases on verified completion', async () => {
    expect(await runBedrockOperation(bedrockJob, host, 'preview')).toMatchObject({
      phase: 'preview',
      configHash: bedrockJob.expectedHash,
    });
    expect(await readdir(home)).toEqual([]);
    expect(host.installPlugin).not.toHaveBeenCalled();
    const result = await runBedrockOperation(bedrockJob, host);
    expect(result).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
      inferenceVerified: false,
      replayAllowed: false,
    });
    const journal = await bedrockHostJournal(home, bedrockJob, false);
    expect((await journal.events()).map((event) => event.phase)).toEqual([
      'started',
      'preflight-ready',
      'plugin-intent',
      'plugin-ready',
      'environment-intent',
      'environment-ready',
      'config-intent',
      'config-acknowledged',
      'discovery-intent',
      'config-complete',
      'complete',
    ]);
    expect(await journal.ownsMaintenance()).toBe(false);
    await expect(runBedrockOperation(bedrockJob, host)).rejects.toThrow(/already started/);
    expect(host.installPlugin).toHaveBeenCalledTimes(1);
  });
  it('refuses stale preview/consent before any native write and records an unchanged outcome', async () => {
    expect(await runBedrockOperation({ ...bedrockJob, expectedHash: 'stale' }, host)).toMatchObject(
      { phase: 'unchanged', maintenanceHeld: false },
    );
    expect(host.installPlugin).not.toHaveBeenCalled();
    expect(host.prepareEnvironment).not.toHaveBeenCalled();
    expect(host.configure).not.toHaveBeenCalled();
  });
  it('retains a shared hold after a lost plugin reply, does not replay and permits only explicit verified-state acceptance', async () => {
    vi.mocked(host.installPlugin).mockRejectedValueOnce(Error('private-plugin-output'));
    const result = await runBedrockOperation(bedrockJob, host);
    expect(result).toMatchObject({ phase: 'uncertain', maintenanceHeld: true });
    expect(JSON.stringify(result)).not.toContain('private-plugin-output');
    expect((await runBedrockOperation(bedrockJob, host, 'inspect')).phase).toBe('uncertain');
    await expect(runBedrockOperation(bedrockJob, host)).rejects.toThrow(/already started/);
    await expect(runBedrockOperation(bedrockJob, host, 'accept-configured')).rejects.toThrow(
      /freshly verified/,
    );
    isConfigured = true;
    expect(await runBedrockOperation(bedrockJob, host, 'accept-configured')).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
      reconciled: true,
    });
    expect(host.installPlugin).toHaveBeenCalledTimes(1);
  });
  it('preserves a competing backup/model hold and fences delayed original delivery when accepting an already configured connection', async () => {
    expect(await runBedrockOperation(bedrockJob, host, 'inspect')).toMatchObject({
      phase: 'not-recorded',
      maintenanceHeld: null,
    });
    const other = await modelHostJournal(home, modelJob, true);
    await other.claim();
    isConfigured = true;
    await expect(runBedrockOperation(bedrockJob, host, 'accept-configured')).rejects.toThrow(
      /Another maintenance/,
    );
    expect(await other.ownsMaintenance()).toBe(true);
    await other.append({ phase: 'unchanged' });
    await other.release();
    expect(await runBedrockOperation(bedrockJob, host, 'accept-configured')).toMatchObject({
      phase: 'complete',
      maintenanceHeld: false,
      reconciled: true,
    });
    await expect(runBedrockOperation(bedrockJob, host)).rejects.toThrow(/already started/);
    expect(host.installPlugin).not.toHaveBeenCalled();
  });
  it('does not proceed after unrelated native edits or failed discovery', async () => {
    vi.mocked(host.revision).mockResolvedValueOnce({
      configHash: 'plugin-revision',
      unrelatedHash: 'b'.repeat(64),
    });
    expect(await runBedrockOperation(bedrockJob, host)).toMatchObject({
      phase: 'uncertain',
      maintenanceHeld: true,
    });
    expect(host.prepareEnvironment).not.toHaveBeenCalled();
    expect(host.configure).not.toHaveBeenCalled();
    const journal = await bedrockHostJournal(home, bedrockJob, false);
    const request = await readFile(
      path.join(home, '.openclaw-aws/bedrock', bedrockJob.operationId, 'request.json'),
      'utf8',
    );
    expect(JSON.parse(request)).toEqual(bedrockJob);
    expect((await journal.events()).at(-1)?.phase).toBe('uncertain');
  });
  it('reports unavailable observation without publishing a historical healthy value', async () => {
    await runBedrockOperation(bedrockJob, host);
    vi.mocked(host.observe).mockRejectedValue(Error('private-auth-output'));
    expect(await runBedrockOperation(bedrockJob, host, 'inspect')).toMatchObject({
      phase: 'complete',
      observed: null,
    });
  });
  it('explicitly aborts a partial plugin setup only when the original native settings are still proven, without replaying writes', async () => {
    vi.mocked(host.installPlugin).mockRejectedValueOnce(new Error('lost plugin reply'));
    await runBedrockOperation(bedrockJob, host);
    expect(await runBedrockOperation(bedrockJob, host, 'abort')).toMatchObject({
      phase: 'aborted',
      maintenanceHeld: false,
      reconciled: true,
    });
    expect(host.installPlugin).toHaveBeenCalledOnce();
    expect(host.configure).not.toHaveBeenCalled();
    expect(host.prepareEnvironment).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
    expect((await runBedrockOperation(bedrockJob, host, 'inspect')).phase).toBe('aborted');
    await expect(runBedrockOperation(bedrockJob, host)).rejects.toThrow(/already started/);
    expect((await runBedrockOperation(bedrockJob, host, 'abort')).phase).toBe('aborted');
  });
  it('retains the hold if provider or unrelated settings changed after the original preflight', async () => {
    vi.mocked(host.prepareEnvironment).mockRejectedValueOnce(
      new Error('environment outcome unknown'),
    );
    await runBedrockOperation(bedrockJob, host);
    vi.mocked(host.revision).mockResolvedValueOnce({
      configHash: 'changed',
      unrelatedHash: 'b'.repeat(64),
    });
    await expect(runBedrockOperation(bedrockJob, host, 'abort')).rejects.toThrow(
      /differ from the original/,
    );
    expect(await (await bedrockHostJournal(home, bedrockJob, false)).ownsMaintenance()).toBe(true);
    expect(host.configure).not.toHaveBeenCalled();
    expect(host.installPlugin).toHaveBeenCalledOnce();
  });
  it('does not invent proof for legacy interrupted history, abort a completed connection or release a competing owner', async () => {
    const legacy = await bedrockHostJournal(home, bedrockJob, true);
    await legacy.claim();
    await legacy.append({ phase: 'started' });
    await legacy.append({ phase: 'plugin-intent' });
    await legacy.append({ phase: 'uncertain' });
    await expect(runBedrockOperation(bedrockJob, host, 'abort')).rejects.toThrow(
      /no durable original-settings proof/,
    );
    expect(await legacy.ownsMaintenance()).toBe(true);
    await rm(path.join(home, '.openclaw-aws'), { recursive: true });
    await runBedrockOperation(bedrockJob, host);
    await expect(runBedrockOperation(bedrockJob, host, 'abort')).rejects.toThrow(
      /original unresolved/,
    );
    await rm(path.join(home, '.openclaw-aws'), { recursive: true });
    vi.mocked(host.installPlugin).mockRejectedValueOnce(new Error('lost reply'));
    await runBedrockOperation(bedrockJob, host);
    // Simulate an externally replaced hold; abort must not release that owner.
    await unlink(path.join(home, '.openclaw-aws/maintenance.json'));
    const other = await modelHostJournal(home, modelJob, true);
    await other.claim();
    await expect(runBedrockOperation(bedrockJob, host, 'abort')).rejects.toThrow(
      /original unresolved/,
    );
    expect(await other.ownsMaintenance()).toBe(true);
  });
  it('validates a durable preflight proof before any plugin intent can be persisted', async () => {
    const journal = await bedrockHostJournal(home, bedrockJob, true);
    await journal.claim();
    await journal.append({ phase: 'started' });
    await expect(journal.append({ phase: 'preflight-ready' })).rejects.toThrow(
      /Invalid Bedrock journal event/,
    );
    await expect(
      journal.append({ phase: 'preflight-ready', unrelatedHash: 'private-or-invalid' }),
    ).rejects.toThrow(/Invalid Bedrock journal event/);
    await journal.append({ phase: 'preflight-ready', unrelatedHash: 'a'.repeat(64) });
    expect((await journal.events()).at(-1)).toMatchObject({ unrelatedHash: 'a'.repeat(64) });
  });
  it('never interprets an unchanged observation as cancellation of a potentially in-flight config write', async () => {
    vi.mocked(host.configure).mockImplementationOnce(async (_job, _revision, record) => {
      await record({
        phase: 'intent',
        beforeHash: 'plugin-revision',
        inferenceRegion: 'eu-central-1',
      });
      throw new Error('patch acknowledgement lost');
    });
    await runBedrockOperation(bedrockJob, host);
    await expect(runBedrockOperation(bedrockJob, host, 'abort')).rejects.toThrow(
      /cannot cancel an in-flight/,
    );
    expect(await (await bedrockHostJournal(home, bedrockJob, false)).ownsMaintenance()).toBe(true);
    expect(host.configure).toHaveBeenCalledOnce();
  });
});
