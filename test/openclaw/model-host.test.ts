import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  sts: vi.fn(),
  ssm: vi.fn(),
  destroy: vi.fn(),
  readFile: vi.fn(),
  client: vi.fn(),
  operation: vi.fn(),
}));
vi.mock('@aws-sdk/credential-providers', () => ({ fromInstanceMetadata: mocks.metadata }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = mocks.sts;
    destroy = mocks.destroy;
    constructor(public config: unknown) {}
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = mocks.ssm;
    destroy = mocks.destroy;
    constructor(public config: unknown) {}
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('node:os', () => ({ homedir: () => '/home/ubuntu' }));
vi.mock('../../src/openclaw/model-client.js', () => ({ createNativeModelClient: mocks.client }));
vi.mock('../../src/openclaw/model-worker.js', () => ({ runModelOperation: mocks.operation }));
import { runAwsModelWorker } from '../../src/openclaw/model-host.js';
import { modelJob } from '../helpers/model-operation.js';
const token = 'fixture-private-gateway-token';
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(process.env).filter((key) => key.startsWith('AWS_')))
    vi.stubEnv(key, undefined);
  vi.stubEnv('AWS_CONFIG_FILE', '/dev/null');
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/dev/null');
  vi.stubEnv('AWS_EC2_METADATA_V1_DISABLED', 'true');
  mocks.metadata.mockReturnValue(async () => ({
    accessKeyId: 'fixture-role',
    secretAccessKey: 'fixture-secret',
  }));
  mocks.readFile.mockResolvedValue(JSON.stringify({ version: modelJob.runtime.openclaw }));
  mocks.sts.mockResolvedValue({
    Account: modelJob.target.account,
    UserId: `${modelJob.target.roleId}:${modelJob.target.instanceId}`,
    Arn: `arn:aws:sts::${modelJob.target.account}:assumed-role/host/${modelJob.target.instanceId}`,
  });
  const name = '/openclaw/test/gateway-token';
  mocks.ssm.mockResolvedValue({
    Parameter: {
      Name: name,
      Type: 'SecureString',
      Value: token,
      ARN: `arn:aws:ssm:eu-central-1:${modelJob.target.account}:parameter${name}`,
    },
  });
  mocks.client.mockReturnValue({ fixture: true });
  mocks.operation.mockImplementation(async (_job, host) => {
    await host.identify();
    host.client(async () => {});
    return { phase: 'complete' };
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('AWS model worker boundary', () => {
  it('uses IMDSv2 and checks exact role/EC2 identity before privately retrieving the scoped Gateway token', async () => {
    const signal = AbortSignal.timeout(10000);
    expect(await runAwsModelWorker(modelJob, 'execute', signal)).toEqual({ phase: 'complete' });
    expect(mocks.metadata).toHaveBeenCalledWith({
      ec2MetadataV1Disabled: true,
      timeout: 3000,
      maxRetries: 2,
    });
    expect(mocks.ssm.mock.calls[0][0].input).toEqual({
      Name: '/openclaw/test/gateway-token',
      WithDecryption: true,
    });
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({ home: '/home/ubuntu', gatewayToken: token, signal }),
    );
    expect(mocks.client.mock.calls[0][0]).not.toHaveProperty('bedrockDeploymentRegion');
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it.each([
    { Account: '999999999999' },
    { UserId: `${modelJob.target.roleId}:i-fffffffffffffffff` },
    { Arn: `arn:aws:sts::999999999999:assumed-role/host/${modelJob.target.instanceId}` },
  ])('refuses a changed AWS host identity before SSM or native access: %j', async (delta) => {
    mocks.sts.mockResolvedValue({ ...(await mocks.sts()), ...delta });
    await expect(runAwsModelWorker(modelJob, 'execute')).rejects.toThrow(
      /selected hosting instance role/,
    );
    expect(mocks.ssm).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });
  it.each([
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT',
    'AWS_ENDPOINT_URL_STS',
  ])('rejects inherited %s before SDK requests', async (name) => {
    vi.stubEnv(name, 'must-not-be-used');
    await expect(runAwsModelWorker(modelJob, 'execute')).rejects.toThrow(/isolated instance-role/);
    expect(mocks.sts).not.toHaveBeenCalled();
    expect(mocks.ssm).not.toHaveBeenCalled();
  });
  it('rejects a different secret ARN/name/type and refuses an implicit runtime upgrade', async () => {
    mocks.ssm.mockResolvedValue({
      Parameter: { Name: '/openclaw/other/gateway-token', Type: 'String', Value: token },
    });
    await expect(runAwsModelWorker(modelJob, 'execute')).rejects.toThrow(
      /credential is unavailable/,
    );
    expect(mocks.client).not.toHaveBeenCalled();
    mocks.readFile.mockResolvedValue('{"version":"unsupported"}');
    await expect(runAwsModelWorker(modelJob, 'execute')).rejects.toThrow(/no implicit upgrade/);
  });
});
