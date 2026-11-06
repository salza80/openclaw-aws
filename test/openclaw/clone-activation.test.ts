import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cloneRecordFixture } from '../helpers/fixtures/clone.js';
import { cloneRequestDigest } from '../../src/openclaw/clone-contract.js';
const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  verify: vi.fn(),
  revoke: vi.fn(),
  ssm: vi.fn(),
  start: vi.fn(),
  install: vi.fn(),
  health: vi.fn(),
  mask: vi.fn(),
}));
vi.mock('../../src/openclaw/restore-control.js', async (load) => ({
  ...(await load<object>()),
  verifiedRestoreTarget: mocks.target,
}));
vi.mock('../../src/openclaw/clone-validate.js', () => ({ verifyNativeClone: mocks.verify }));
vi.mock('../../src/openclaw/clone-access.js', () => ({
  assertCloneSourceAccessRevoked: mocks.revoke,
}));
vi.mock('@aws-sdk/client-ssm', async (load) => ({
  ...(await load<object>()),
  SSMClient: class {
    send = mocks.ssm;
    destroy() {}
  },
}));
vi.mock('../../src/openclaw/recovery-service.js', async (load) => ({
  ...(await load<object>()),
  createRecoveryServiceHost: (options: {
    validate: () => Promise<void>;
    commit: () => Promise<void>;
  }) => ({
    validate: options.validate,
    commit: options.commit,
    start: mocks.start,
    unmaskAndInstall: mocks.install,
    health: mocks.health,
    maskInactive: mocks.mask,
  }),
}));
import { runCloneActivation } from '../../src/openclaw/clone-activation.js';
let root: string;
let work: string;
let config: Record<string, unknown>;
const fixture = cloneRecordFixture();
const job = fixture.delivery!.job;
const inactive = vi.fn(async () => {});
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), 'clone-activate-'));
  work = path.join(root, 'jobs', fixture.operationId);
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(path.join(work, 'ready.json'), JSON.stringify(fixture.result), { mode: 0o600 });
  await writeFile(
    path.join(root, 'maintenance.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'clone',
      operationId: fixture.operationId,
      stackId: job.target.stackId,
      roleId: job.target.roleId,
      digest: cloneRequestDigest(job),
    }),
    { mode: 0o600 },
  );
  config = {
    cron: { enabled: false, triggers: { enabled: false } },
    hooks: { enabled: false, internal: { enabled: false } },
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port: 18789,
      auth: { mode: 'token', token: 'fresh-gateway-token', allowTailscale: false },
      tailscale: { mode: 'off' },
    },
    channels: {},
    memory: { search: { enabled: false } },
    agents: {
      defaults: { skipBootstrap: true, heartbeat: { every: '0m' } },
      entries: { main: { heartbeat: { every: '0m' }, memory: { search: { enabled: false } } } },
    },
  };
  mocks.verify.mockImplementation(async (options) => {
    options.validateConfig(config);
    return { configurationHash: fixture.result!.configurationHash, members: [] };
  });
  mocks.target.mockResolvedValue({
    root,
    work,
    operationId: fixture.operationId,
    packageJson: '/unused/package.json',
    home: '/home/ubuntu',
    credentials: async () => ({ accessKeyId: 'fixture', secretAccessKey: 'fixture' }),
    request: () => ({}),
    assertInactive: inactive,
  });
  mocks.ssm.mockResolvedValue({
    Parameter: {
      Name: '/openclaw/restored/gateway-token',
      Type: 'SecureString',
      Value: 'fresh-gateway-token',
    },
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('fresh clone activation boundary', () => {
  it('checks configured holds and revoked source access before starting and again before committing', async () => {
    const result = await runCloneActivation(job);
    expect(result.phase).toBe('active');
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.revoke).toHaveBeenCalledTimes(2);
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0],
    );
    expect(JSON.parse(await readFile(path.join(work, 'activated.json'), 'utf8'))).toEqual(result);
    await expect(readFile(path.join(root, 'maintenance.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    vi.clearAllMocks();
    expect(await runCloneActivation(job)).toEqual(result);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.health).toHaveBeenCalledOnce();
  });
  it('refuses remaining decrypted source files before unmasking or installing a service', async () => {
    await mkdir(path.join(work, 'staging'));
    await expect(runCloneActivation(job)).rejects.toThrow('source staging');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('refuses source permissions or copied automatic integrations before activating', async () => {
    mocks.revoke.mockRejectedValueOnce(new Error('source access remains'));
    await expect(runCloneActivation(job)).rejects.toThrow('source access remains');
    config.mcp = { servers: { source: { command: 'remote' } } };
    await expect(runCloneActivation(job)).rejects.toThrow('disconnected');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('remasks on post-start config drift and leaves maintenance owned for inspection', async () => {
    mocks.health.mockImplementationOnce(async () => {
      config.channels = { telegram: { enabled: true } };
    });
    await expect(runCloneActivation(job)).rejects.toThrow('masked and inactive');
    expect(mocks.mask).toHaveBeenCalledOnce();
    await expect(readFile(path.join(work, 'activated.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await readFile(path.join(root, 'maintenance.json'), 'utf8')).kind).toBe(
      'clone',
    );
  });
});
