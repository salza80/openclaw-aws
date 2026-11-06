import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreJobFixture } from '../helpers/fixtures/backup.js';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  stage: vi.fn(),
  policy: vi.fn(),
  content: vi.fn(),
  copy: vi.fn(),
  native: vi.fn(),
  verify: vi.fn(),
  ssm: vi.fn(),
  close: vi.fn(),
  inactive: vi.fn(),
}));
vi.mock('../../src/openclaw/restore-control.js', async (load) => ({
  ...(await load<object>()),
  verifiedRestoreTarget: mocks.context,
}));
vi.mock('../../src/openclaw/recovery-staging.js', () => ({ stageRecoveryArchive: mocks.stage }));
vi.mock('../../src/openclaw/clone-source.js', () => ({ readCloneSourcePolicy: mocks.policy }));
vi.mock('../../src/openclaw/clone-content.js', () => ({ planCloneContent: mocks.content }));
vi.mock('../../src/openclaw/clone-workspaces.js', () => ({ installCloneWorkspaces: mocks.copy }));
vi.mock('../../src/openclaw/clone-native.js', () => ({ initializeNativeClone: mocks.native }));
vi.mock('../../src/openclaw/clone-validate.js', () => ({ verifyNativeClone: mocks.verify }));
vi.mock('@aws-sdk/client-secrets-manager', async (load) => ({
  ...(await load<object>()),
  SecretsManagerClient: class {
    send = vi.fn();
    destroy = mocks.close;
  },
}));
vi.mock('@aws-sdk/client-ssm', async (load) => ({
  ...(await load<object>()),
  SSMClient: class {
    send = mocks.ssm;
    destroy = mocks.close;
  },
}));
import { runCloneWorker } from '../../src/openclaw/clone-worker.js';
import { parseCloneJob, parseCloneWorkerResult } from '../../src/openclaw/clone-contract.js';
import { clonePolicyDigest } from '../../src/openclaw/clone-preview.js';
let root: string;
const policy = {
  schemaVersion: 1 as const,
  agents: [{ id: 'main' }],
  credentialPaths: [],
  omissions: [],
};
const job = () =>
  parseCloneJob({
    ...structuredClone(restoreJobFixture),
    kind: 'clone',
    preview: { contentDigest: 'a'.repeat(64), policyDigest: clonePolicyDigest(policy) },
    credentials: { primary: 'openrouter-api-key', providers: ['openrouter-api-key'] },
  });
const work = () => path.join(root, 'jobs', job().bootstrap.operationId);
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), 'claw-clone-worker-'));
  const selected = job();
  mocks.context.mockResolvedValue({
    job: selected,
    root,
    work: work(),
    operationId: selected.bootstrap.operationId,
    owner: {
      deploymentName: selected.target.deploymentName,
      deploymentId: selected.target.stackId,
      operationId: selected.bootstrap.operationId,
    },
    credentials: async () => ({ accessKeyId: 'fixture', secretAccessKey: 'fixture' }),
    request: () => ({ abortSignal: AbortSignal.timeout(30000) }),
    assertInactive: mocks.inactive,
    packageJson: '/fixture/native/package.json',
  });
  mocks.stage.mockImplementation(async () => {
    const stagingDirectory = path.join(work(), 'staging');
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(stagingDirectory, 'source.env'),
      'SOURCE_CHANNEL_KEY=must-not-remain',
    );
    return { moves: [], stagingDirectory };
  });
  mocks.policy.mockResolvedValue(policy);
  mocks.content.mockResolvedValue({
    schemaVersion: 1,
    digest: selected.preview.contentDigest,
    members: [
      {
        id: 'main',
        workspace: '/home/ubuntu/.openclaw/workspaces/main',
        agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
        files: [],
        omitted: [],
      },
    ],
  });
  mocks.copy.mockResolvedValue({ members: 1, files: 3 });
  mocks.native.mockResolvedValue({
    members: selected.backup.capture.members,
    configurationHash: 'c'.repeat(64),
  });
  mocks.ssm.mockImplementation(
    async (command: { input: { ResourceId?: string; Name?: string } }) =>
      command.input.ResourceId
        ? {
            TagList: [
              { Key: 'openclaw-aws:deployment-id', Value: selected.target.stackId },
              { Key: 'openclaw-aws:restore-id', Value: selected.bootstrap.operationId },
            ],
          }
        : {
            Parameter: {
              Name: command.input.Name,
              Type: 'SecureString',
              Value: command.input.Name?.endsWith('gateway-token')
                ? 'd'.repeat(48)
                : 'fresh-explicit-provider-key',
            },
          },
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('locked independent clone worker', () => {
  it('binds the preview before fresh native setup, reads only owned target keys and removes source secrets/history before certifying readiness', async () => {
    const result = await runCloneWorker(job());
    expect(result.kind).toBe('clone');
    expect(result.configurationHash).toBe('c'.repeat(64));
    expect(mocks.copy).toHaveBeenCalledBefore(mocks.native);
    expect(mocks.native.mock.calls[0][0]).toMatchObject({
      providerCredential: 'fresh-explicit-provider-key',
      gatewayToken: 'd'.repeat(48),
    });
    const names = mocks.ssm.mock.calls.map(([command]) => command.input.Name).filter(Boolean);
    expect(names.every((name) => name.startsWith('/openclaw/restored/'))).toBe(true);
    await expect(lstat(path.join(work(), 'staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    const receipt = await readFile(path.join(work(), 'ready.json'), 'utf8');
    expect(receipt).not.toContain('provider-key');
    expect(receipt).not.toContain('must-not-remain');
    const maintenance = JSON.parse(await readFile(path.join(root, 'maintenance.json'), 'utf8'));
    expect(maintenance.kind).toBe('clone');
    await runCloneWorker(job());
    expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({ configurationHash: result.configurationHash }),
    );
  });
  it('blocks changed reviewed content before copying or initializing native identity', async () => {
    mocks.content.mockResolvedValue({ ...(await mocks.content()), digest: 'f'.repeat(64) });
    await expect(runCloneWorker(job())).rejects.toThrow('differs');
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
    await expect(lstat(path.join(work(), 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never adopts source or foreign provider credentials and rejects altered completion metadata', async () => {
    mocks.ssm.mockResolvedValue({
      TagList: [{ Key: 'openclaw-aws:restore-id', Value: 'other-operation' }],
    });
    await expect(runCloneWorker(job())).rejects.toThrow('another operation');
    expect(mocks.native).not.toHaveBeenCalled();
    expect(() => parseCloneWorkerResult({ schemaVersion: 1, kind: 'restore' }, job())).toThrow(
      'differs',
    );
  });
});
