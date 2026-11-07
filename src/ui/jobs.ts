import { randomUUID, createHash } from 'node:crypto';
import { readdir, lstat, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getConfigRoot } from '../cli/utils/config.js';
import { assertDirectoryChain } from '../openclaw/restore-layout.js';
import { createPrivateControlRecord, privateModelJson } from '../openclaw/model-journal.js';
import { modelText } from '../openclaw/model-contract.js';
import { teamId } from '../openclaw/team-contract.js';
import { parseUiActionRequest } from './input.js';
import { parseUiPlanView, parseUiOutcome } from './public.js';
import type { UiBackend, UiActionRequest, UiJobView, UiPreparedAction } from './contracts.js';

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
type Status = Pick<UiJobView, 'phase' | 'updatedAt' | 'progress' | 'result'>;
/** This is invocation tracking for local AWS operations, never an agent task
 * scheduler. Native lifecycle journals remain the execution authority. */
export class UiJobs {
  readonly root = path.join(getConfigRoot(), 'ui', 'jobs');
  private prepared = new Map<string, UiPreparedAction>();
  private claims = new Map<string, Promise<UiJobView>>();
  private active = new Set<string>();
  private writes = new Map<string, Promise<void>>();
  private completions = new Map<string, Promise<void>>();
  constructor(private readonly backend: UiBackend) {}
  private file(id: string, name: string) {
    return path.join(this.root, teamId(id), name + '.json');
  }
  private async directory(id?: string, create = false) {
    const directory = id ? path.join(this.root, teamId(id)) : this.root;
    await assertDirectoryChain(directory, getConfigRoot(), create);
    if ((await lstat(directory)).mode & 0o077)
      throw new Error('UI operation directory must be private');
  }
  private async status(id: string): Promise<Status> {
    const row = await privateModelJson(this.file(id, 'status'));
    if (
      Object.keys(row).some((key) => !['phase', 'updatedAt', 'progress', 'result'].includes(key)) ||
      !['preview', 'running', 'complete', 'uncertain', 'cancelled'].includes(String(row.phase)) ||
      !Number.isFinite(Date.parse(String(row.updatedAt))) ||
      !Array.isArray(row.progress) ||
      row.progress.length > 25
    )
      throw new Error('Invalid UI operation status');
    return {
      phase: row.phase as Status['phase'],
      updatedAt: modelText(row.updatedAt, 64),
      progress: row.progress.map((value) => modelText(value, 500)),
      ...(row.result === undefined ? {} : { result: parseUiOutcome(row.result) }),
    };
  }
  private update(id: string, change: (previous: Status) => Status) {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(async () => {
      const status = change(await this.status(id));
      const temporary = this.file(id, 'status') + '.' + randomUUID() + '.tmp';
      try {
        await createPrivateControlRecord(temporary, status);
        await rename(temporary, this.file(id, 'status'));
        const directory = await open(path.dirname(temporary), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (!absent(error)) throw error;
        });
      }
    });
    this.writes.set(id, next);
    return next;
  }
  async preview(input: UiActionRequest): Promise<UiJobView> {
    const request = parseUiActionRequest(input),
      id = randomUUID();
    const operation = await this.backend.prepare(request, id);
    try {
      const view = parseUiPlanView(operation.view);
      if (view.id !== id || view.action !== request.action)
        throw new Error('UI preview identity changed');
      await this.directory(id, true);
      await createPrivateControlRecord(this.file(id, 'intent'), {
        schemaVersion: 1,
        request,
        view,
      });
      await createPrivateControlRecord(this.file(id, 'status'), {
        phase: 'preview',
        updatedAt: new Date().toISOString(),
        progress: [],
      });
      this.prepared.set(id, operation);
      return await this.get(id);
    } catch (error) {
      await operation.cancel?.();
      throw error;
    }
  }
  async get(id: string): Promise<UiJobView> {
    await this.directory(id);
    const intent = await privateModelJson(this.file(id, 'intent'));
    if (
      intent.schemaVersion !== 1 ||
      Object.keys(intent).some((key) => !['schemaVersion', 'request', 'view'].includes(key))
    )
      throw new Error('Invalid UI operation intent');
    const view = parseUiPlanView(intent.view);
    const request = parseUiActionRequest(intent.request);
    if (view.id !== id || view.action !== request.action)
      throw new Error('UI operation identity mismatch');
    let status: Status;
    try {
      status = await this.status(id);
    } catch (error) {
      if (!absent(error)) throw error;
      status = {
        phase: 'uncertain',
        updatedAt: view.createdAt,
        progress: [
          'Local operation status is incomplete. Inspect the original request before retrying.',
        ],
      };
    }
    let started = false;
    try {
      const marker = await privateModelJson(this.file(id, 'started'));
      const digest = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
      if (
        marker.id !== id ||
        marker.digest !== digest ||
        Object.keys(marker).some((key) => !['id', 'digest'].includes(key))
      )
        throw new Error('UI execution marker changed');
      started = true;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (
      (status.phase === 'running' || (status.phase === 'preview' && started)) &&
      !this.active.has(id)
    )
      status.phase = 'uncertain';
    if (status.phase === 'preview' && !this.prepared.has(id)) {
      status.phase = 'uncertain';
      status.progress = [
        ...status.progress,
        'This backend does not own the original preview. Inspect its operation or prepare a fresh review; it cannot be applied here.',
      ].slice(-25);
    }
    return { ...view, ...status };
  }
  async list(): Promise<UiJobView[]> {
    try {
      await this.directory();
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
    const names = (await readdir(this.root)).filter((name) => /^[a-f0-9-]{36}$/.test(name));
    if (names.length > 4096)
      throw new Error('UI operation history exceeds its supported inventory');
    const ordered = await Promise.all(
      names.map(async (name) => ({
        name,
        updated: (await lstat(path.join(this.root, name))).mtimeMs,
      })),
    );
    ordered.sort((a, b) => b.updated - a.updated);
    return Promise.all(ordered.slice(0, 256).map(({ name }) => this.get(name)));
  }
  apply(id: string): Promise<UiJobView> {
    return this.claim(id, false);
  }
  cancel(id: string): Promise<UiJobView> {
    return this.claim(id, true);
  }
  private claim(id: string, cancel: boolean) {
    teamId(id);
    const prior = this.claims.get(id);
    if (prior) return prior.then(() => this.get(id));
    const claim = Promise.resolve().then(async () => {
      const current = await this.get(id);
      if (current.phase !== 'preview') return current;
      const operation = this.prepared.get(id);
      if (!operation)
        throw new Error(
          'Preview expired after backend restart; inspect and prepare a new approval',
        );
      if (cancel) {
        await operation.cancel?.();
        await this.update(id, (status) => ({
          ...status,
          phase: 'cancelled',
          updatedAt: new Date().toISOString(),
        }));
        this.prepared.delete(id);
        return this.get(id);
      }
      const intent = await privateModelJson(this.file(id, 'intent'));
      await createPrivateControlRecord(this.file(id, 'started'), {
        id,
        digest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
      });
      this.active.add(id);
      try {
        await this.update(id, (status) => ({
          ...status,
          phase: 'running',
          updatedAt: new Date().toISOString(),
        }));
      } catch (error) {
        this.active.delete(id);
        throw error;
      }
      this.prepared.delete(id);
      const completion = this.execute(id, operation);
      this.completions.set(id, completion);
      void completion.finally(() => this.completions.delete(id));
      return this.get(id);
    });
    this.claims.set(id, claim);
    return claim;
  }
  private async execute(id: string, operation: UiPreparedAction) {
    try {
      const result = parseUiOutcome(
        await operation.apply((input) => {
          const message = modelText(input.replace(/[\r\n\0]/g, ' ').slice(0, 500), 500);
          void this.update(id, (status) => ({
            ...status,
            updatedAt: new Date().toISOString(),
            progress: [...status.progress, message].slice(-25),
          })).catch(() => {});
        }),
      );
      await this.update(id, (status) => ({
        ...status,
        phase: 'complete',
        updatedAt: new Date().toISOString(),
        result,
      }));
    } catch {
      await this.update(id, (status) => ({
        ...status,
        phase: 'uncertain',
        updatedAt: new Date().toISOString(),
        progress: [
          ...status.progress,
          'Operation outcome was not confirmed. Inspect the original operation before any retry.',
        ].slice(-25),
      })).catch(() => {});
    } finally {
      this.active.delete(id);
    }
  }
  async closePreviews() {
    // Browser disconnect never calls this. Backend shutdown may discard only
    // unapplied previews; started operations retain their durable uncertainty.
    const ids = [...this.prepared.keys()].filter((id) => !this.claims.has(id));
    await Promise.allSettled(ids.map((id) => this.cancel(id)));
  }
  async drain() {
    await Promise.allSettled([...this.completions.values()]);
  }
}
