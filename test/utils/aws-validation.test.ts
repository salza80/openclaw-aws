import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({ accessKeyId: 'TEST', secretAccessKey: 'TEST' }),
}));

const stsSendMock = vi.hoisted(() => vi.fn());
const ec2SendMock = vi.hoisted(() => vi.fn());
const ec2DestroyMock = vi.hoisted(() => vi.fn());
const ec2ClientConfigMock = vi.hoisted(() => vi.fn());
const cfnSendMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy() {}
  },
  GetCallerIdentityCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    constructor(config: Record<string, unknown>) {
      ec2ClientConfigMock(config);
    }
    send = ec2SendMock;
    destroy = ec2DestroyMock;
  },
  DescribeRegionsCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  DescribeInstanceTypesCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = cfnSendMock;
    destroy() {}
  },
  DescribeStacksCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
}));

vi.mock('ora', async () => {
  const { createSpinnerMock } = await import('../helpers/mocks/spinner.js');
  return {
    default: vi.fn(() => createSpinnerMock()),
  };
});

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({
  default: promptsMock,
}));

vi.mock('./cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
}));

import {
  validateAWSCredentials,
  validateAWSRegion,
  validateInstanceCapabilities,
  getCDKBootstrapVersion,
  checkCDKBootstrap,
  runCDKBootstrap,
  validatePreDeploy,
  validateInstanceType,
  validateStackExists,
  validateNodeVersion,
  validateSSMPlugin,
} from '../../src/cli/utils/aws-validation.js';
import { AWSError, ValidationError } from '../../src/cli/utils/errors.js';
import type { OpenClawConfig } from '../../src/cli/types/index.js';

function instanceMetadata(instanceType = 't3.small', memoryMiB = 2048, architectures = ['x86_64']) {
  return {
    InstanceType: instanceType,
    MemoryInfo: { SizeInMiB: memoryMiB },
    ProcessorInfo: { SupportedArchitectures: architectures },
  };
}

const deploymentConfig: OpenClawConfig = {
  version: '1.0',
  aws: { region: 'us-east-1' },
  network: { useDefaultVpc: true },
  instance: { name: 'openclaw-alpha', type: 't3.small' },
  features: { cloudWatchLogs: true },
  stack: { name: 'OpenclawStack-alpha' },
  openclaw: { apiProvider: 'anthropic-api-key' },
};

describe('aws-validation utils', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('validateAWSCredentials returns credentials', async () => {
    stsSendMock.mockResolvedValue({
      Account: '123456789012',
      UserId: 'user',
      Arn: 'arn:aws:iam::123456789012:user/test',
    });
    const result = await validateAWSCredentials('us-east-1');
    expect(result.account).toBe('123456789012');
    expect(result.userId).toBe('user');
  });

  it('validateAWSCredentials throws on missing fields', async () => {
    stsSendMock.mockResolvedValue({ Account: '123' });
    await expect(validateAWSCredentials('us-east-1')).rejects.toBeInstanceOf(AWSError);
  });

  it('validateAWSRegion returns true for valid region', async () => {
    ec2SendMock.mockResolvedValue({});
    await expect(validateAWSRegion('us-east-1')).resolves.toBe(true);
  });

  it('validateAWSRegion throws ValidationError on failure', async () => {
    ec2SendMock.mockRejectedValue(Object.assign(new Error('boom'), { name: 'InvalidRegion' }));
    await expect(validateAWSRegion('moon-1')).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ['t3a.small', 2048],
    ['t3.medium', 4096],
    ['t8i.small', 2048],
  ])('accepts AWS-confirmed x86_64 %s with %s MiB', async (instanceType, memoryMiB) => {
    ec2SendMock.mockResolvedValue({ InstanceTypes: [instanceMetadata(instanceType, memoryMiB)] });
    await expect(
      validateInstanceCapabilities(instanceType, 'eu-central-1'),
    ).resolves.toBeUndefined();
    expect(ec2ClientConfigMock).toHaveBeenCalledWith({ region: 'eu-central-1' });
    expect(ec2SendMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: { InstanceTypes: [instanceType] } }),
    );
    expect(ec2DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed instance types before creating an EC2 client', async () => {
    await expect(validateInstanceCapabilities('bad.type', 'us-east-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(ec2ClientConfigMock).not.toHaveBeenCalled();
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it.each([
    ['t4g.small', 2048, ['arm64'], 'does not support x86_64'],
    ['t3.nano', 512, ['x86_64'], 'at least 2048 MiB'],
    ['t3a.micro', 1024, ['x86_64'], 'at least 2048 MiB'],
  ])('rejects unsupported %s capacity', async (instanceType, memoryMiB, architectures, message) => {
    ec2SendMock.mockResolvedValue({
      InstanceTypes: [instanceMetadata(instanceType, memoryMiB, architectures)],
    });
    await expect(validateInstanceCapabilities(instanceType, 'us-east-1')).rejects.toThrow(message);
    expect(ec2DestroyMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['absent instance metadata', {}],
    ['empty instance metadata', { InstanceTypes: [] }],
    ['different instance type', { InstanceTypes: [instanceMetadata('t3.medium')] }],
    ['duplicate instance metadata', { InstanceTypes: [instanceMetadata(), instanceMetadata()] }],
    ['missing memory', { InstanceTypes: [{ ...instanceMetadata(), MemoryInfo: undefined }] }],
    [
      'missing architecture',
      { InstanceTypes: [{ ...instanceMetadata(), ProcessorInfo: undefined }] },
    ],
    ['empty architecture', { InstanceTypes: [instanceMetadata('t3.small', 1024, [])] }],
    ['invalid memory', { InstanceTypes: [instanceMetadata('t3.small', Number.NaN)] }],
  ])('fails closed for %s', async (_description, response) => {
    ec2SendMock.mockResolvedValue(response);
    await expect(validateInstanceCapabilities('t3.small', 'us-east-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(ec2DestroyMock).toHaveBeenCalledTimes(1);
  });

  it.each(['UnauthorizedOperation', 'TimeoutError'])(
    'preserves actionable AWS %s failures and destroys the EC2 client',
    async (name) => {
      const original = Object.assign(new Error('EC2 lookup failed'), { name });
      ec2SendMock.mockRejectedValue(original);
      const failure = await validateInstanceCapabilities('t3.small', 'eu-central-1').catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AWSError);
      expect(failure).toMatchObject({
        cause: original,
        message: expect.stringContaining(`${name}: EC2 lookup failed`),
        suggestions: expect.arrayContaining([
          expect.stringContaining('ec2:DescribeInstanceTypes'),
          expect.stringContaining('connectivity'),
        ]),
      });
      expect((failure as Error).message).not.toContain('Invalid AWS region');
      expect(ec2DestroyMock).toHaveBeenCalledTimes(1);
    },
  );

  it('getCDKBootstrapVersion parses BootstrapVersion output', async () => {
    cfnSendMock.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BootstrapVersion', OutputValue: '31' }] }],
    });
    await expect(getCDKBootstrapVersion('us-east-1')).resolves.toBe(31);
  });

  it('getCDKBootstrapVersion returns null when missing', async () => {
    cfnSendMock.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    await expect(getCDKBootstrapVersion('us-east-1')).resolves.toBeNull();
  });

  it('checkCDKBootstrap reports meetsMinimum', async () => {
    cfnSendMock.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BootstrapVersion', OutputValue: '45' }] }],
    });
    const result = await checkCDKBootstrap('123456789012', 'us-east-1');
    expect(result.bootstrapped).toBe(true);
    expect(result.meetsMinimum).toBe(true);
  });

  it('runCDKBootstrap calls execa with cdk bootstrap', async () => {
    execaMock.mockResolvedValue({});
    await runCDKBootstrap('123456789012', 'us-east-1', 'dev');
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = execaMock.mock.calls[0];
    expect(String(cmd)).toContain('cdk');
    expect(args).toEqual([
      'bootstrap',
      '--no-notices',
      '--no-version-reporting',
      'aws://123456789012/us-east-1',
    ]);
    expect(options).toEqual(expect.objectContaining({ stdio: 'inherit' }));
    expect(options).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ AWS_PROFILE: 'dev' }) }),
    );
  });

  it('runCDKBootstrap throws AWSError on failure', async () => {
    execaMock.mockRejectedValue(new Error('fail'));
    await expect(runCDKBootstrap('123456789012', 'us-east-1')).rejects.toBeInstanceOf(AWSError);
  });

  it('validateInstanceType accepts valid values and rejects invalid', () => {
    expect(() => validateInstanceType('t3.micro')).not.toThrow();
    expect(() => validateInstanceType('bad.type')).toThrow(ValidationError);
  });

  it('validateStackExists returns true/false', async () => {
    cfnSendMock.mockResolvedValueOnce({});
    await expect(validateStackExists('stack', 'us-east-1')).resolves.toBe(true);
    cfnSendMock.mockRejectedValueOnce(
      Object.assign(new Error('Stack with id stack does not exist'), { name: 'ValidationError' }),
    );
    await expect(validateStackExists('stack', 'us-east-1')).resolves.toBe(false);
  });

  it.each(['v10.0.0', 'v22.0.0', 'v22.12.9'])('rejects unsupported Node %s', (version) => {
    const original = process.version;
    try {
      Object.defineProperty(process, 'version', { value: version, configurable: true });
      expect(() => validateNodeVersion()).toThrow(ValidationError);
    } finally {
      Object.defineProperty(process, 'version', { value: original, configurable: true });
    }
  });

  it.each(['v22.13.0', 'v22.20.0', 'v24.22.2'])('accepts supported Node %s', (version) => {
    const original = process.version;
    try {
      Object.defineProperty(process, 'version', { value: version, configurable: true });
      expect(() => validateNodeVersion()).not.toThrow();
    } finally {
      Object.defineProperty(process, 'version', { value: original, configurable: true });
    }
  });

  it('validateSSMPlugin throws when missing', async () => {
    execaMock.mockRejectedValue(new Error('missing'));
    await expect(validateSSMPlugin()).rejects.toBeInstanceOf(ValidationError);
  });

  it('validatePreDeploy succeeds when bootstrap meets minimum', async () => {
    stsSendMock.mockResolvedValue({
      Account: '123456789012',
      UserId: 'user',
      Arn: 'arn:aws:iam::123456789012:user/test',
    });
    ec2SendMock
      .mockResolvedValueOnce({})
      .mockResolvedValue({ InstanceTypes: [instanceMetadata()] });
    cfnSendMock.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BootstrapVersion', OutputValue: '45' }] }],
    });

    await expect(validatePreDeploy(deploymentConfig)).resolves.toBeUndefined();
  });

  it('validatePreDeploy throws when bootstrap required and user declines', async () => {
    stsSendMock.mockResolvedValue({
      Account: '123456789012',
      UserId: 'user',
      Arn: 'arn:aws:iam::123456789012:user/test',
    });
    ec2SendMock
      .mockResolvedValueOnce({})
      .mockResolvedValue({ InstanceTypes: [instanceMetadata()] });
    cfnSendMock.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    promptsMock.mockResolvedValue({ runBootstrap: false });

    await expect(validatePreDeploy(deploymentConfig)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ['ARM', instanceMetadata('t3.small', 2048, ['arm64'])],
    ['512 MiB', instanceMetadata('t3.small', 512)],
    ['missing metadata', { InstanceType: 't3.small' }],
  ])('rejects %s before checking or running CDK bootstrap', async (_description, metadata) => {
    stsSendMock.mockResolvedValue({ Account: '123456789012', UserId: 'user', Arn: 'test' });
    ec2SendMock.mockResolvedValueOnce({}).mockResolvedValue({ InstanceTypes: [metadata] });
    cfnSendMock.mockResolvedValue({ Stacks: [] });
    promptsMock.mockResolvedValue({ runBootstrap: true });

    await expect(validatePreDeploy(deploymentConfig)).rejects.toBeInstanceOf(ValidationError);
    expect(cfnSendMock).not.toHaveBeenCalled();
    expect(promptsMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
    expect(ec2DestroyMock).toHaveBeenCalledTimes(2);
  });

  it('stops before CDK bootstrap when the capability lookup fails', async () => {
    stsSendMock.mockResolvedValue({ Account: '123456789012', UserId: 'user', Arn: 'test' });
    const original = Object.assign(new Error('EC2 access denied'), {
      name: 'UnauthorizedOperation',
    });
    ec2SendMock.mockResolvedValueOnce({}).mockRejectedValue(original);
    cfnSendMock.mockResolvedValue({ Stacks: [] });
    promptsMock.mockResolvedValue({ runBootstrap: true });

    await expect(validatePreDeploy(deploymentConfig)).rejects.toMatchObject({ cause: original });
    expect(cfnSendMock).not.toHaveBeenCalled();
    expect(promptsMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
    expect(ec2DestroyMock).toHaveBeenCalledTimes(2);
  });
});
