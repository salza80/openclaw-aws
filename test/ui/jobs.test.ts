import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, unlink, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/cli/utils/config.js', () => ({ getConfigRoot: () => paths.root }));
import { UiJobs } from '../../src/ui/jobs.js';
import { fixtureBackend } from '../helpers/ui.js';

beforeEach(async () => {
  paths.root = await mkdtemp(path.join(tmpdir(), 'openclaw-ui-jobs-'));
});
afterEach(async () => {
  await rm(paths.root, { recursive: true, force: true });
});
describe('durable local UI invocations', () => {
  it('applies duplicate concurrent requests once and survives browser reconnect', async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const apply = vi.fn(async () => {
      await wait;
      return { summary: 'Stopped once.', facts: [] };
    });
    const jobs = new UiJobs(fixtureBackend(apply));
    const preview = await jobs.preview({ action: 'stop', name: 'alpha' });
    const first = await Promise.all([jobs.apply(preview.id), jobs.apply(preview.id)]);
    expect(first.every((job) => job.phase === 'running')).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await jobs.get(preview.id)).phase).toBe('running');
    // A replacement backend cannot replay an invocation whose reply was lost.
    const restarted = new UiJobs(fixtureBackend(apply));
    expect((await restarted.get(preview.id)).phase).toBe('uncertain');
    await restarted.apply(preview.id);
    expect(apply).toHaveBeenCalledTimes(1);
    finish();
    await jobs.drain();
    expect(await restarted.get(preview.id)).toMatchObject({
      phase: 'complete',
      result: { summary: 'Stopped once.' },
    });
  });
  it('does not apply previews from an earlier backend and preserves missing-status uncertainty', async () => {
    const apply = vi.fn(async () => ({ summary: 'Done.', facts: [] }));
    const jobs = new UiJobs(fixtureBackend(apply));
    const preview = await jobs.preview({ action: 'stop', name: 'alpha' });
    expect((await new UiJobs(fixtureBackend(apply)).apply(preview.id)).phase).toBe('uncertain');
    await unlink(path.join(jobs.root, preview.id, 'status.json'));
    expect((await jobs.get(preview.id)).phase).toBe('uncertain');
    await jobs.apply(preview.id);
    expect(apply).not.toHaveBeenCalled();
  });
  it('records failure without raw errors and cancellation cannot start work', async () => {
    const apply = vi.fn(async () => {
      throw new Error('SECRET-SDK-OUTPUT');
    });
    const jobs = new UiJobs(fixtureBackend(apply));
    const failed = await jobs.preview({ action: 'stop', name: 'alpha' });
    await jobs.apply(failed.id);
    await jobs.drain();
    const result = await jobs.get(failed.id);
    expect(result.phase).toBe('uncertain');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const cancelled = await jobs.preview({ action: 'stop', name: 'alpha' });
    await Promise.all([jobs.cancel(cancelled.id), jobs.apply(cancelled.id)]);
    expect((await jobs.get(cancelled.id)).phase).toBe('cancelled');
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('refuses private context fields in public previews and keeps records private', async () => {
    const backend = fixtureBackend();
    const original = backend.prepare;
    backend.prepare = async (request, id) => {
      const prepared = await original(request, id);
      Object.assign(prepared.view, { awsEnv: { AWS_SECRET_ACCESS_KEY: 'SECRET' } });
      return prepared;
    };
    await expect(new UiJobs(backend).preview({ action: 'stop', name: 'alpha' })).rejects.toThrow(
      'Unsupported public',
    );
    const jobs = new UiJobs(fixtureBackend());
    const preview = await jobs.preview({ action: 'stop', name: 'alpha' });
    const intent = path.join(jobs.root, preview.id, 'intent.json');
    expect(await readFile(intent, 'utf8')).not.toContain('SECRET');
    await chmod(intent, 0o644);
    await expect(jobs.get(preview.id)).rejects.toThrow();
  });
});
