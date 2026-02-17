import { describe, it, expect, vi, afterEach } from 'vitest';

const stsSendMock = vi.hoisted(() => vi.fn());
const ec2SendMock = vi.hoisted(() => vi.fn());
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
    send = ec2SendMock;
    destroy() {}
  },
  DescribeRegionsCommand: class {
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

const spinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  warn: vi.fn().mockReturnThis(),
  text: '',
}));
vi.mock('ora', () => ({
  default: vi.fn(() => spinner),
}));

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({
  default: promptsMock,
}));

vi.mock('./cdk.js', () => ({
  getCDKBinary: vi.fn(() => 'cdk'),
}));

import {
  applyAwsProfile,
  validateAWSCredentials,
  validateAWSRegion,
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

describe('aws-validation utils', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('applyAwsProfile sets AWS env vars', () => {
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_SDK_LOAD_CONFIG;
    applyAwsProfile('dev');
    expect(process.env.AWS_PROFILE).toBe('dev');
    expect(process.env.AWS_SDK_LOAD_CONFIG).toBe('1');
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
    ec2SendMock.mockRejectedValue(new Error('boom'));
    await expect(validateAWSRegion('moon-1')).rejects.toBeInstanceOf(ValidationError);
  });

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
    expect(options).toEqual(expect.objectContaining({ env: expect.objectContaining({ AWS_PROFILE: 'dev' }) }));
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
    cfnSendMock.mockRejectedValueOnce(new Error('nope'));
    await expect(validateStackExists('stack', 'us-east-1')).resolves.toBe(false);
  });

  it('validateNodeVersion throws on old Node', () => {
    const original = process.version;
    Object.defineProperty(process, 'version', { value: 'v10.0.0', configurable: true });
    expect(() => validateNodeVersion()).toThrow(ValidationError);
    Object.defineProperty(process, 'version', { value: original, configurable: true });
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
    ec2SendMock.mockResolvedValue({});
    cfnSendMock.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'BootstrapVersion', OutputValue: '45' }] }],
    });

    const config: OpenClawConfig = {
      version: '1.0',
      aws: { region: 'us-east-1' },
      network: { useDefaultVpc: true },
      instance: { name: 'openclaw-alpha', type: 't3.micro' },
      features: { cloudWatchLogs: true },
      stack: { name: 'OpenclawStack-alpha' },
      openclaw: { apiProvider: 'anthropic-api-key' },
    };

    await expect(validatePreDeploy(config)).resolves.toBeUndefined();
  });

  it('validatePreDeploy throws when bootstrap required and user declines', async () => {
    stsSendMock.mockResolvedValue({
      Account: '123456789012',
      UserId: 'user',
      Arn: 'arn:aws:iam::123456789012:user/test',
    });
    ec2SendMock.mockResolvedValue({});
    cfnSendMock.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    promptsMock.mockResolvedValue({ runBootstrap: false });

    const config: OpenClawConfig = {
      version: '1.0',
      aws: { region: 'us-east-1' },
      network: { useDefaultVpc: true },
      instance: { name: 'openclaw-alpha', type: 't3.micro' },
      features: { cloudWatchLogs: true },
      stack: { name: 'OpenclawStack-alpha' },
      openclaw: { apiProvider: 'anthropic-api-key' },
    };

    await expect(validatePreDeploy(config)).rejects.toBeInstanceOf(ValidationError);
  });
});
