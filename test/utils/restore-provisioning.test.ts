import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { GetParametersByPathCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  ssm: vi.fn(),
  close: vi.fn(),
  execa: vi.fn(),
  lock: vi.fn(),
  state: vi.fn(),
  guard: vi.fn(),
  environment: vi.fn(),
  held: false,
}));
vi.mock('execa', () => ({ execa: mocks.execa }));
vi.mock('../../src/cli/utils/aws.js', () => ({
  getStackStatus: mocks.status,
  getInstanceIdFromStack: vi.fn(async () => 'i-target'),
  waitForSSM: vi.fn(async () => true),
}));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: () => ({ send: mocks.ssm, destroy: mocks.close }),
}));
vi.mock('../../src/operations/lock.js', () => ({ withDeploymentLock: mocks.lock }));
vi.mock('../../src/operations/state.js', () => ({
  assertDeploymentTarget: mocks.guard,
  recordDeploymentState: mocks.state,
}));
vi.mock('../../src/cli/utils/config-store.js', () => ({
  resolveOutputsPath: () => '/private/restore-outputs.json',
}));
vi.mock('../../src/cli/utils/cdk.js', () => ({
  getCDKBinary: () => 'cdk',
  getCDKAppCommand: (value: string) => `node ${value}`,
  withCDKWorkspace: async (env: object, operation: (workspace: object) => Promise<unknown>) =>
    operation({ env, cwd: '/private/cdk-workspace' }),
}));
import { provisionRestoreTarget, deployDeployment } from '../../src/operations/deployment.js';
import { StackNotFoundError } from '../../src/cli/utils/errors.js';
const restore = {
  operationId: '11111111-1111-1111-1111-111111111111',
  volumeGiB: 60,
  runtime: { openclaw: '2026.11.1', node: '24.22.2' },
};
const base = makeCommandContext();
const ctx = { ...base, target: { ...base.target, environment: mocks.environment } };
const stackId = `arn:aws:cloudformation:us-east-1:123456789012:stack/${ctx.config.stack.name}/target-guid`;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.held = false;
  mocks.status.mockImplementation(async () => {
    if (!mocks.execa.mock.calls.some(([, args]) => args[0] === 'deploy'))
      throw new StackNotFoundError(ctx.config.stack.name, ctx.target.region);
    return {
      stackId,
      stackName: ctx.config.stack.name,
      instanceId: 'i-target',
      stackStatus: 'CREATE_COMPLETE',
    };
  });
  mocks.ssm.mockImplementation(async (command) =>
    command instanceof GetParametersByPathCommand ? { Parameters: [] } : { Version: 1 },
  );
  mocks.environment.mockResolvedValue({
    AWS_REGION: ctx.target.region,
    AWS_ACCESS_KEY_ID: 'fixture-access',
    AWS_SECRET_ACCESS_KEY: 'fixture-private',
  });
  mocks.execa.mockResolvedValue({ stdout: '' });
  mocks.lock.mockImplementation(async (_ctx, action) => {
    mocks.held = true;
    try {
      return await action();
    } finally {
      mocks.held = false;
    }
  });
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'readFileSync').mockReturnValue(
    JSON.stringify({ [ctx.config.stack.name]: { DeploymentId: stackId, InstanceId: 'i-target' } }),
  );
});
afterEach(() => vi.restoreAllMocks());
describe('inactive restore provisioning', () => {
  it('creates only a fresh Gateway credential and holds the lock through restoration', async () => {
    const finish = vi.fn(async (outputs) => {
      expect(mocks.held).toBe(true);
      return { id: outputs.DeploymentId, restored: true };
    });
    await expect(provisionRestoreTarget(ctx, { restore }, finish)).resolves.toEqual({
      id: stackId,
      restored: true,
    });
    const writes = mocks.ssm.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutParameterCommand);
    expect(writes).toHaveLength(1);
    expect(writes[0].input).toMatchObject({
      Name: '/openclaw/alpha/gateway-token',
      Type: 'SecureString',
      Overwrite: false,
    });
    expect(writes[0].input.Value).toMatch(/^[a-f0-9]{48}$/);
    const deploy = mocks.execa.mock.calls.find(([, args]) => args[0] === 'deploy');
    expect(deploy?.[2]).toMatchObject({
      extendEnv: false,
      cwd: '/private/cdk-workspace',
      env: {
        OPENCLAW_CDK_OPERATION: 'restore',
        OPENCLAW_RESTORE_BOOTSTRAP: JSON.stringify(restore),
      },
    });
    expect(JSON.stringify(deploy?.[2].env)).not.toContain(writes[0].input.Value);
    expect(mocks.state).toHaveBeenCalledWith(
      expect.objectContaining({ name: ctx.name }),
      expect.objectContaining({ stackId }),
      { newlyCreated: true },
    );
    expect(mocks.held).toBe(false);
  });
  it('rejects namespace collisions before creating a token or infrastructure', async () => {
    mocks.ssm.mockResolvedValueOnce({
      Parameters: [{ Name: '/openclaw/alpha/providers/openrouter-api-key/api-key' }],
    });
    const finish = vi.fn();
    await expect(provisionRestoreTarget(ctx, { restore }, finish)).rejects.toThrow(
      'parameters already exist',
    );
    expect(mocks.execa).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(mocks.ssm.mock.calls.some(([command]) => command instanceof PutParameterCommand)).toBe(
      false,
    );
  });
  it('treats a denied or incomplete inventory as failure rather than absence', async () => {
    for (const response of [undefined, {}]) {
      mocks.ssm.mockResolvedValueOnce(response);
      await expect(provisionRestoreTarget(ctx, { restore }, vi.fn())).rejects.toThrow(
        'confirm an empty',
      );
    }
    mocks.ssm.mockRejectedValueOnce(Object.assign(Error('denied'), { name: 'AccessDenied' }));
    await expect(provisionRestoreTarget(ctx, { restore }, vi.fn())).rejects.toThrow('denied');
    expect(mocks.execa).not.toHaveBeenCalled();
  });
  it('follows empty inventory pages and rejects repeated cursors', async () => {
    mocks.ssm
      .mockResolvedValueOnce({ Parameters: [], NextToken: 'again' })
      .mockResolvedValueOnce({ Parameters: [], NextToken: 'again' });
    await expect(provisionRestoreTarget(ctx, { restore }, vi.fn())).rejects.toThrow(
      'pagination repeated',
    );
    expect(mocks.ssm).toHaveBeenCalledTimes(2);
    expect(mocks.execa).not.toHaveBeenCalled();
  });
  it('refuses an existing target stack without writing any secret', async () => {
    mocks.status.mockResolvedValueOnce({ stackId, stackStatus: 'CREATE_COMPLETE' });
    await expect(provisionRestoreTarget(ctx, { restore }, vi.fn())).rejects.toThrow(
      'already exists',
    );
    expect(mocks.ssm).not.toHaveBeenCalled();
  });
  it('does not start restoration without matching live target outputs', async () => {
    const finish = vi.fn();
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    await expect(provisionRestoreTarget(ctx, { restore }, finish)).rejects.toThrow(
      'outputs are missing',
    );
    expect(finish).not.toHaveBeenCalled();
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({
        [ctx.config.stack.name]: { DeploymentId: `${stackId}-stale`, InstanceId: 'i-target' },
      }),
    );
    mocks.execa.mockClear();
    await expect(provisionRestoreTarget(ctx, { restore }, finish)).rejects.toThrow(
      'live AWS identity',
    );
    expect(finish).not.toHaveBeenCalled();
  });
  it('refuses missing or incompatible recorded runtime before acquiring the target', async () => {
    await expect(
      provisionRestoreTarget(
        ctx,
        { restore: { ...restore, runtime: { openclaw: 'latest', node: '24.22.2' } } },
        vi.fn(),
      ),
    ).rejects.toThrow('recorded OpenClaw');
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.ssm).not.toHaveBeenCalled();
  });
  it('releases the operation lock after a failed native stage without implying activation', async () => {
    const failure = Error('native restore failed; Gateway remains masked');
    await expect(
      provisionRestoreTarget(ctx, { restore }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(mocks.held).toBe(false);
    expect(mocks.state.mock.calls[0][2]).not.toHaveProperty('observed');
  });
  it('retains fresh creation behavior with its provider key and ordinary readiness', async () => {
    await deployDeployment(ctx, { apiProvider: 'anthropic-api-key', apiKey: 'fixture-provider' });
    expect(
      mocks.ssm.mock.calls.filter(([command]) => command instanceof PutParameterCommand),
    ).toHaveLength(2);
    expect(
      mocks.ssm.mock.calls.some(([command]) => command instanceof GetParametersByPathCommand),
    ).toBe(false);
    const deploy = mocks.execa.mock.calls.find(([, args]) => args[0] === 'deploy');
    expect(deploy?.[2].env.OPENCLAW_CDK_OPERATION).toBe('deploy');
    expect(deploy?.[2].env.OPENCLAW_RESTORE_BOOTSTRAP).toBeUndefined();
  });
});
