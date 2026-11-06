import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { restoreJobFixture as job } from '../helpers/fixtures/backup.js';
const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  stage: vi.fn(),
  layout: vi.fn(),
  reconcile: vi.fn(),
  sts: vi.fn(),
  secrets: vi.fn(),
  ssm: vi.fn(),
  systemctl: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
}));
const absent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
vi.mock('node:os', () => ({ homedir: () => '/home/ubuntu' }));
vi.mock('node:fs/promises', () => ({
  open: vi.fn(async (filename: string, flag: string) => {
    if (flag === 'wx' && mocks.files.has(filename))
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    if (flag === 'wx') mocks.files.set(filename, '');
    return {
      writeFile: async (body: string) => {
        mocks.files.set(filename, body);
      },
      sync: async () => {},
      close: async () => {},
    };
  }),
  mkdir: vi.fn(async () => {}),
  lstat: vi.fn(async (filename: string) => {
    if (!mocks.files.has(filename)) throw absent();
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o600,
      uid: process.getuid?.(),
      size: mocks.files.get(filename)!.length,
    };
  }),
  readFile: vi.fn(async (filename: string) => {
    if (!mocks.files.has(filename)) throw absent();
    return mocks.files.get(filename)!;
  }),
  writeFile: vi.fn(async (filename: string, body: string, options: { flag?: string }) => {
    if (options.flag === 'wx' && mocks.files.has(filename))
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    mocks.files.set(filename, body);
  }),
  rm: mocks.remove,
}));
vi.mock('execa', () => ({ execa: mocks.systemctl }));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromInstanceMetadata: () => async () => ({
    accessKeyId: 'FIXTURE-ROLE',
    secretAccessKey: 'private-role',
  }),
}));
vi.mock('@aws-sdk/client-sts', async (load) => ({
  ...(await load<object>()),
  STSClient: class {
    send = mocks.sts;
    destroy = mocks.close;
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', async (load) => ({
  ...(await load<object>()),
  SecretsManagerClient: class {
    send = mocks.secrets;
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
vi.mock('../../src/openclaw/native-restore-host.js', () => ({ stageNativeRestore: mocks.stage }));
vi.mock('../../src/openclaw/restore-layout.js', () => ({ installRestoreLayout: mocks.layout }));
vi.mock('../../src/openclaw/restore-reconciliation.js', () => ({
  reconcileNativeRestore: mocks.reconcile,
}));
import { runRestoreWorker } from '../../src/openclaw/restore-worker.js';
const root = '/home/ubuntu/.openclaw-aws';
const work = `${root}/jobs/${job.bootstrap.operationId}`;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.files.clear();
  mocks.files.set(
    `${root}/restore-bootstrap.json`,
    JSON.stringify({
      schemaVersion: 1,
      operationId: job.bootstrap.operationId,
      stackId: job.target.stackId,
      openclaw: job.bootstrap.runtime.openclaw,
      node: job.bootstrap.runtime.node,
      gateway: 'masked',
    }),
  );
  mocks.files.set(
    new URL('../lib/node_modules/openclaw/package.json', `file://${process.execPath}`).pathname,
    JSON.stringify({ version: job.bootstrap.runtime.openclaw }),
  );
  mocks.systemctl.mockResolvedValue({ stdout: 'masked\ninactive' });
  mocks.sts.mockResolvedValue({
    Account: job.target.account,
    UserId: `${job.target.roleId}:${job.target.instanceId}`,
    Arn: `arn:aws:sts::${job.target.account}:assumed-role/target-role/${job.target.instanceId}`,
  });
  mocks.secrets.mockResolvedValue({
    ARN: job.backup.job.key.arn,
    VersionId: job.backup.job.key.versionId,
    SecretString: 'private-recovery-key',
  });
  mocks.ssm.mockResolvedValue({
    Parameter: {
      Name: '/openclaw/restored/gateway-token',
      Type: 'SecureString',
      Value: 'a'.repeat(48),
    },
  });
  mocks.stage.mockResolvedValue({
    moves: [{ source: `${work}/staging/payload/state`, destination: '/home/ubuntu/.openclaw' }],
  });
  mocks.reconcile.mockResolvedValue({
    members: job.backup.capture.members,
    imported: { parameterNames: ['/openclaw/restored/providers/openrouter-api-key/api-key'] },
    sessionHold: { held: 3 },
  });
});
describe('inactive remote recovery worker', () => {
  it('refuses a replaced runtime even when an old extraction receipt could be reused', async () => {
    mocks.files.set(
      new URL('../lib/node_modules/openclaw/package.json', `file://${process.execPath}`).pathname,
      JSON.stringify({ version: '2026.1.1' }),
    );
    await expect(runRestoreWorker(job)).rejects.toThrow('runtime differs');
    expect(mocks.sts).not.toHaveBeenCalled();
    expect(mocks.layout).not.toHaveBeenCalled();
  });
  it('verifies the new role, reads retained/fresh secrets from separate namespaces and returns only filtered readiness', async () => {
    const result = await runRestoreWorker(job);
    expect(result).toMatchObject({
      phase: 'ready-inactive',
      memberCount: 1,
      heldSessionCount: 3,
      stackId: job.target.stackId,
    });
    expect(mocks.stage.mock.calls[0][0]).toMatchObject({
      job: job.backup.job,
      pluginDirectory: job.pluginDirectory,
      passphrase: 'private-recovery-key',
    });
    expect(mocks.ssm.mock.calls[0][0]).toBeInstanceOf(GetParameterCommand);
    expect(mocks.ssm.mock.calls[0][0].input.Name).toBe('/openclaw/restored/gateway-token');
    expect(mocks.reconcile.mock.calls[0][0].gatewayToken).toBe('a'.repeat(48));
    expect(JSON.stringify(result)).not.toContain('private-');
    expect([...mocks.files.values()].join(' ')).not.toContain('private-recovery-key');
    expect(mocks.files.has(`${root}/maintenance.json`)).toBe(true);
    expect(mocks.systemctl.mock.calls.every(([, args]) => args[1] === 'show')).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });
  it('resumes the same owned extraction and never downloads or replaces the backup again', async () => {
    await runRestoreWorker(job);
    await runRestoreWorker(job);
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect(mocks.secrets).toHaveBeenCalledTimes(1);
    expect(mocks.layout).toHaveBeenCalledTimes(2);
  });
  it('refuses a wrong bootstrap, active service or role before touching native state', async () => {
    mocks.files.set(`${root}/restore-bootstrap.json`, '{}');
    await expect(runRestoreWorker(job)).rejects.toThrow('bootstrap identity');
    expect(mocks.sts).not.toHaveBeenCalled();
    mocks.files.set(
      `${root}/restore-bootstrap.json`,
      JSON.stringify({
        schemaVersion: 1,
        operationId: job.bootstrap.operationId,
        stackId: job.target.stackId,
        openclaw: job.bootstrap.runtime.openclaw,
        node: job.bootstrap.runtime.node,
        gateway: 'masked',
      }),
    );
    mocks.systemctl.mockResolvedValueOnce({ stdout: 'loaded\nactive' });
    await expect(runRestoreWorker(job)).rejects.toThrow('persistently masked');
    mocks.sts.mockResolvedValueOnce({
      Account: job.target.account,
      UserId: 'AROA-OTHER:other',
      Arn: 'arn:aws:sts::123456789012:assumed-role/other/other',
    });
    await expect(runRestoreWorker(job)).rejects.toThrow('target instance role');
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.layout).not.toHaveBeenCalled();
  });
  it('leaves maintenance ownership after failure and refuses another restore operation', async () => {
    mocks.stage.mockRejectedValueOnce(new Error('corrupt or unavailable archive'));
    await expect(runRestoreWorker(job)).rejects.toThrow('archive');
    expect(mocks.files.has(`${root}/maintenance.json`)).toBe(true);
    expect(mocks.layout).not.toHaveBeenCalled();
    const owner = JSON.parse(mocks.files.get(`${root}/maintenance.json`)!);
    owner.operationId = '33333333-3333-3333-3333-333333333333';
    mocks.files.set(`${root}/maintenance.json`, JSON.stringify(owner));
    await expect(runRestoreWorker(job)).rejects.toThrow('Another maintenance');
  });
});
