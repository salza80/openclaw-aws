import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTeamOperation, type TeamWorkerHost } from '../../src/openclaw/team-worker.js';
import { parseTeamJob, type TeamJob } from '../../src/openclaw/team-contract.js';
import { parseTeamDefinition } from '../../src/openclaw/team-definition.js';
import { modelJob } from '../helpers/model-operation.js';

let home: string;
let config: Record<string, unknown>;
let revision: number;
let writes: number;
let loseReply: boolean;
let rejectPatch: boolean;
let host: TeamWorkerHost;
let previewJob: TeamJob;
const secret = 'private-provider-credential-never-a-team-receipt';
const merge = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch))
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge((result[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  return result;
};
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'team-worker-'));
  const workspace = path.join(home, '.openclaw/workspace');
  const agentDir = path.join(home, '.openclaw/agents/main/agent');
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Original fresh role instructions\n');
  revision = 0;
  writes = 0;
  loseReply = false;
  rejectPatch = false;
  config = {
    agents: { ownership: 'explicit', entries: { main: { workspace, agentDir } } },
    models: { providers: { private: { apiKey: secret } } },
  };
  host = {
    home,
    identify: vi.fn(async () => {}),
    members: async () =>
      Object.entries(
        (config.agents as { entries: Record<string, { workspace: string; agentDir: string }> })
          .entries,
      ).map(([id, roots]) => ({ id, workspace: roots.workspace, agentDir: roots.agentDir })),
    client: {
      health: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      record: async () => {},
      async call(method, params) {
        if (method === 'config.get')
          return {
            valid: true,
            hash: 'opaque:revision:' + revision,
            config: structuredClone(config),
          };
        if (method === 'agents.list')
          return { agents: (await host.members()).map((member) => ({ id: member.id })) };
        if (method === 'config.patch') {
          writes++;
          if (rejectPatch) throw new Error('Patch reply unavailable');
          if (params.baseHash !== 'opaque:revision:' + revision)
            throw new Error('Native revision conflict');
          config = merge(config, JSON.parse(params.raw as string));
          revision++;
          if (loseReply) throw new Error('Connection lost after native commit');
          return { ok: true };
        }
        throw new Error('Unexpected native method');
      },
    },
  };
  previewJob = parseTeamJob({
    schemaVersion: 1,
    kind: 'native-team',
    operationId: modelJob.operationId,
    teamId: modelJob.operationId,
    target: modelJob.target,
    runtime: modelJob.runtime,
    bedrockRole: false,
    definition: parseTeamDefinition({
      schemaVersion: 1,
      topology: 'single-host',
      coordinator: 'lead',
      members: [
        { id: 'lead', role: 'Coordinator', instructions: 'Collect actual findings.' },
        { id: 'researcher', role: 'Researcher', instructions: 'Research the task.' },
      ],
    }),
    action: { kind: 'preview' },
  });
});
afterEach(async () => rm(home, { recursive: true, force: true }));
async function prepare(): Promise<TeamJob> {
  const preview = await runTeamOperation(previewJob, host, 'execute');
  if (!('preflight' in preview)) throw Error('No preview');
  return parseTeamJob({
    ...previewJob,
    operationId: '22222222-2222-2222-2222-222222222222',
    action: { kind: 'configure', allowRestart: false, ...preview.preflight },
  });
}
describe('durable native team setup', () => {
  it('previews without writing source instructions, claiming maintenance or returning credentials', async () => {
    const preview = await runTeamOperation(previewJob, host, 'execute');
    expect(preview).toMatchObject({
      recordedPhase: 'preview',
      requestedConfigurationVerified: false,
      inferenceVerified: false,
    });
    expect(JSON.stringify(preview)).not.toContain(secret);
    expect(await readdir(home)).toEqual(['.openclaw']);
    expect(writes).toBe(0);
    expect(await readFile(path.join(home, '.openclaw/workspace/AGENTS.md'), 'utf8')).toContain(
      'Original fresh',
    );
  });
  it('configures one complete roster, preserves the provider and adopts completed setup without another native write', async () => {
    const job = await prepare();
    await expect(runTeamOperation(job, host, 'execute')).resolves.toMatchObject({
      recordedPhase: 'complete',
      requestedConfigurationVerified: true,
      maintenanceHeld: false,
    });
    await expect(runTeamOperation(job, host, 'resume')).resolves.toMatchObject({
      recordedPhase: 'complete',
      requestedConfigurationVerified: true,
    });
    expect(writes).toBe(1);
    await expect(runTeamOperation(job, host, 'abort')).rejects.toThrow('cannot be aborted');
    expect(JSON.stringify(config)).toContain(secret);
    const records = path.join(home, '.openclaw-aws/team-operations', job.operationId);
    for (const file of await readdir(records))
      expect(await readFile(path.join(records, file), 'utf8')).not.toContain(secret);
    expect(await host.members()).toHaveLength(2);
  });
  it('recovers a lost reply by verifying the applied roster and files, never replaying the patch', async () => {
    const job = await prepare();
    loseReply = true;
    await expect(runTeamOperation(job, host, 'execute')).rejects.toThrow('Connection lost');
    await expect(runTeamOperation(job, host, 'abort')).rejects.toThrow('may be in flight');
    await expect(runTeamOperation(job, host, 'execute')).rejects.toThrow('already started');
    await expect(runTeamOperation(job, host, 'resume')).resolves.toMatchObject({
      recordedPhase: 'complete',
      requestedConfigurationVerified: true,
      maintenanceHeld: false,
    });
    expect(writes).toBe(1);
  });
  it('retains uncertainty and maintenance when a patch outcome cannot be established', async () => {
    const job = await prepare();
    rejectPatch = true;
    await expect(runTeamOperation(job, host, 'execute')).rejects.toThrow('unavailable');
    await expect(runTeamOperation(job, host, 'inspect')).resolves.toMatchObject({
      recordedPhase: 'configuration-uncertain',
      requestedConfigurationVerified: false,
      gatewayHealthy: null,
      maintenanceHeld: true,
    });
    await expect(runTeamOperation(job, host, 'resume')).rejects.toThrow('roster');
    expect(writes).toBe(1);
  });
  it('refuses native drift before file changes and blocks unrelated existing agents', async () => {
    const job = await prepare();
    revision++;
    await expect(runTeamOperation(job, host, 'execute')).rejects.toThrow('changed after approval');
    expect(writes).toBe(0);
    expect(await readFile(path.join(home, '.openclaw/workspace/AGENTS.md'), 'utf8')).toContain(
      'Original fresh',
    );
    (config.agents as { entries: Record<string, unknown> }).entries.unrelated = {
      workspace: path.join(home, 'unrelated'),
      agentDir: path.join(home, 'unrelated-agent'),
    };
    await expect(runTeamOperation(previewJob, host, 'execute')).rejects.toThrow('unrelated');
  });
  it('aborts a pre-config failure without overwriting changed files and fences delayed setup', async () => {
    const job = await prepare();
    const filename = path.join(home, '.openclaw/workspace/AGENTS.md');
    await writeFile(filename, 'Concurrent user instructions\n');
    await expect(runTeamOperation(job, host, 'execute')).rejects.toThrow('changed after preview');
    await expect(runTeamOperation(job, host, 'abort')).resolves.toMatchObject({
      recordedPhase: 'aborted',
      maintenanceHeld: false,
      retainedInstructionFiles: true,
    });
    await expect(runTeamOperation(job, host, 'execute')).rejects.toThrow('aborted');
    expect(await readFile(filename, 'utf8')).toBe('Concurrent user instructions\n');
    expect(writes).toBe(0);
  });
  it('requires actual host identity before reading or writing any team state', async () => {
    vi.mocked(host.identify).mockRejectedValue(new Error('wrong instance role'));
    await expect(runTeamOperation(previewJob, host, 'execute')).rejects.toThrow('wrong instance');
    expect(await readdir(home)).toEqual(['.openclaw']);
    expect(writes).toBe(0);
  });
});
