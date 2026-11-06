import { mkdtemp, rm, writeFile, readFile, symlink, link, readdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  modelHostJournal,
  privateModelJson,
  installModelRequest,
} from '../../src/openclaw/model-journal.js';
import { modelJobDigest, parseModelJob } from '../../src/openclaw/model-contract.js';
import { modelJob } from '../helpers/model-operation.js';
import type { ModelMutationRecord } from '../../src/openclaw/model-control.js';
let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'openclaw-model-journal-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const mutation: ModelMutationRecord = {
  phase: 'intent',
  scope: modelJob.scope,
  beforeHash: 'opaque:revision:0',
  requested: 'openrouter/new',
  previous: { primary: 'openrouter/old', fallbacks: ['openrouter/fallback'] },
  previousPublished: 'openrouter/old',
};
const root = () => path.join(home, '.openclaw-aws');
const work = () => path.join(root(), 'models', modelJob.operationId);
describe('model operation contract and durable host journal', () => {
  it('installs immutable nonsecret requests separately from the mutation journal, without silently changing a delivered request', async () => {
    const filename = await installModelRequest(home, modelJob);
    expect(filename).toBe(
      path.join(root(), 'model-requests', modelJob.operationId, 'request.json'),
    );
    expect(await privateModelJson(filename)).toEqual(modelJob);
    expect(await installModelRequest(home, modelJob)).toBe(filename);
    await expect(installModelRequest(home, { ...modelJob, bedrockRole: true })).rejects.toThrow(
      /another request/,
    );
    await expect(readdir(path.join(root(), 'models'))).rejects.toThrow();
  });
  it('binds canonical request order and rejects credentials, retargeting, invalid scopes, paid probes and implicit restart consent', () => {
    expect(parseModelJob(modelJob)).toEqual(modelJob);
    expect(
      parseModelJob({
        ...modelJob,
        target: {
          ...modelJob.target,
          stackId: modelJob.target.stackId.replace('OpenclawStack-test', 'Existing-Custom-Stack'),
        },
      }).target.stackId,
    ).toContain('Existing-Custom-Stack');
    expect(modelJobDigest({ ...modelJob, target: { ...modelJob.target } })).toBe(
      modelJobDigest(modelJob),
    );
    for (const bad of [
      { ...modelJob, gatewayToken: 'never-store-this' },
      { ...modelJob, target: { ...modelJob.target, account: '999999999999' } },
      { ...modelJob, action: { ...modelJob.action, allowRestart: undefined } },
      { ...modelJob, action: { kind: 'probe' } },
      { ...modelJob, action: { kind: 'list', offset: 0, limit: 51 } },
      { ...modelJob, action: { kind: 'list', offset: -1, limit: 1 } },
      { ...modelJob, scope: { kind: 'agent', agentId: '__proto__' } },
      { ...modelJob, scope: { kind: 'default', agentId: 'researcher' } },
      { ...modelJob, runtime: { ...modelJob.runtime, openclaw: 'latest' } },
    ])
      expect(() => parseModelJob(bad)).toThrow();
  });
  it('persists only immutable request/model records, adopts reads and never replays a started operation', async () => {
    const journal = await modelHostJournal(home, modelJob, true);
    await journal.claim();
    await journal.append({ phase: 'started' });
    await journal.append(mutation);
    const reopened = await modelHostJournal(home, modelJob, false);
    expect((await reopened.events()).map((row) => row.phase)).toEqual(['started', 'intent']);
    await expect(reopened.claim()).rejects.toThrow(/already started/);
    await expect(modelHostJournal(home, { ...modelJob, bedrockRole: true }, true)).rejects.toThrow(
      /another request/,
    );
    expect(await reopened.ownsMaintenance()).toBe(true);
    await reopened.append({ ...mutation, phase: 'uncertain' });
    await expect(reopened.release()).rejects.toThrow(/Unresolved/);
    await reopened.append({ ...mutation, phase: 'complete' });
    await reopened.release();
    expect(await reopened.ownsMaintenance()).toBe(false);
    expect((await reopened.events()).at(-1)?.phase).toBe('complete');
  });
  it('refuses another backup/recovery hold without changing it, even when old', async () => {
    const journal = await modelHostJournal(home, modelJob, true);
    const held = JSON.stringify({
      schemaVersion: 1,
      kind: 'restore',
      operationId: 'other',
      startedAt: '2001-01-01',
    });
    await writeFile(path.join(root(), 'maintenance.json'), held, { mode: 0o600 });
    await expect(journal.claim()).rejects.toThrow(/maintenance operation owns/);
    await expect(journal.release()).rejects.toThrow(/ownership changed/);
    expect(await readFile(path.join(root(), 'maintenance.json'), 'utf8')).toBe(held);
  });
  it('rejects changed mutation identities, impossible transitions, corrupt or missing event files', async () => {
    const journal = await modelHostJournal(home, modelJob, true);
    await journal.claim();
    await expect(journal.append(mutation)).rejects.toThrow(/transition/);
    await journal.append({ phase: 'started' });
    await journal.append(mutation);
    await expect(
      journal.append({
        ...mutation,
        phase: 'acknowledged',
        previousPublished: 'openrouter/foreign',
      }),
    ).rejects.toThrow(/identity changed/);
    expect(await readdir(work())).toHaveLength(3);
    await writeFile(path.join(work(), 'event-0003.json'), '{}', { mode: 0o600 });
    await expect(journal.events()).rejects.toThrow(/incomplete/);
    expect(await journal.ownsMaintenance()).toBe(true);
  });
  it('rejects links, hardlinks, FIFOs and public control files instead of following or blocking on them', async () => {
    const privateFile = path.join(home, 'private.json');
    await writeFile(privateFile, '{}', { mode: 0o600 });
    const pointer = path.join(home, 'pointer.json');
    await symlink(privateFile, pointer);
    await expect(privateModelJson(pointer)).rejects.toThrow();
    const hard = path.join(home, 'hard.json');
    await link(privateFile, hard);
    await expect(privateModelJson(hard)).rejects.toThrow(/unsafe/);
    await rm(hard);
    await chmod(privateFile, 0o644);
    await expect(privateModelJson(privateFile)).rejects.toThrow(/unsafe/);
    const fifo = path.join(home, 'fifo');
    await execa('mkfifo', [fifo]);
    await expect(privateModelJson(fifo)).rejects.toThrow(/unsafe/);
  });
  it('refuses to overwrite or release substituted ownership and refuses a journal directory symlink', async () => {
    const journal = await modelHostJournal(home, modelJob, true);
    await journal.claim();
    await rm(path.join(root(), 'maintenance.json'));
    await writeFile(path.join(root(), 'maintenance.json'), '{"kind":"foreign"}', { mode: 0o600 });
    await expect(journal.append({ phase: 'started' })).rejects.toThrow(/ownership changed/);
    await expect(journal.release()).rejects.toThrow(/ownership changed/);
    await rm(work(), { recursive: true });
    await symlink(home, work());
    await expect(modelHostJournal(home, modelJob, true)).rejects.toThrow(/unsafe|foreign/);
  });
});
