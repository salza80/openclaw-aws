import { describe, it, expect, vi, afterEach } from 'vitest';

const cfnSendMock = vi.hoisted(() => vi.fn());
const cfnDestroyMock = vi.hoisted(() => vi.fn());
const ssmSendMock = vi.hoisted(() => vi.fn());
const ssmDestroyMock = vi.hoisted(() => vi.fn());
const ec2SendMock = vi.hoisted(() => vi.fn());
const ec2DestroyMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createCloudFormationClient: vi.fn(() => ({
    send: cfnSendMock,
    destroy: cfnDestroyMock,
  })),
  createSsmClient: vi.fn(() => ({
    send: ssmSendMock,
    destroy: ssmDestroyMock,
  })),
  createEc2Client: vi.fn(() => ({
    send: ec2SendMock,
    destroy: ec2DestroyMock,
  })),
}));

vi.mock('@aws-sdk/client-cloudformation', async () => {
  const { createAwsCommandClass } = await import('../helpers/mocks/aws-commands.js');
  return {
    DescribeStacksCommand: createAwsCommandClass<Record<string, unknown>>(),
    DescribeStackResourcesCommand: createAwsCommandClass<Record<string, unknown>>(),
  };
});

vi.mock('@aws-sdk/client-ssm', async () => {
  const { createAwsCommandClass } = await import('../helpers/mocks/aws-commands.js');
  return {
    DescribeInstanceInformationCommand: createAwsCommandClass<Record<string, unknown>>(),
    SendCommandCommand: createAwsCommandClass<Record<string, unknown>>(),
    GetCommandInvocationCommand: createAwsCommandClass<Record<string, unknown>>(),
  };
});

vi.mock('@aws-sdk/client-ec2', async () => {
  const { createAwsCommandClass } = await import('../helpers/mocks/aws-commands.js');
  return {
    DescribeInstancesCommand: createAwsCommandClass<Record<string, unknown>>(),
  };
});

vi.mock('../../src/cli/utils/errors.js', async () =>
  (await import('../helpers/mocks/errors.js')).createErrorsModuleMock({
    withRetry: (await import('../helpers/mocks/errors.js')).passthroughWithRetry,
  }),
);

import {
  getInstanceIdFromStack,
  resolveInstanceId,
  checkSSMStatus,
  getSSMStatus,
  checkGatewayStatus,
  waitForSSM,
  getStackStatus,
  getStackOutputs,
} from '../../src/cli/utils/aws.js';
import { AWSError, StackNotFoundError } from '../../src/cli/utils/errors.js';
import {
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';

describe('aws utils', () => {
  afterEach(() => {
    vi.clearAllMocks();
    cfnSendMock.mockReset();
  });

  const stackLookups = [
    ['getStackStatus', getStackStatus],
    ['getStackOutputs', getStackOutputs],
    ['getInstanceIdFromStack', getInstanceIdFromStack],
  ] as const;

  it.each(stackLookups)('%s identifies a confirmed missing stack', async (_name, lookup) => {
    const error = Object.assign(new Error('Stack with id stack does not exist'), {
      name: 'ValidationError',
    });
    cfnSendMock.mockRejectedValue(error);

    await expect(lookup('stack', 'us-east-1')).rejects.toMatchObject({
      name: 'StackNotFoundError',
      cause: error,
    });
    expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
  });

  it.each(stackLookups)(
    '%s preserves other CloudFormation validation errors',
    async (_name, lookup) => {
      const error = Object.assign(new Error('Invalid stack identifier'), {
        name: 'ValidationError',
      });
      cfnSendMock.mockRejectedValue(error);

      await expect(lookup('stack', 'us-east-1')).rejects.toBe(error);
      expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
    },
  );

  it('getStackStatus identifies an empty stack response as missing', async () => {
    cfnSendMock.mockResolvedValue({ Stacks: [] });
    await expect(getStackStatus('stack', 'us-east-1')).rejects.toBeInstanceOf(StackNotFoundError);
  });

  it('getInstanceIdFromStack returns instance ID', async () => {
    cfnSendMock.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'InstanceId', OutputValue: 'i-123' }] }],
    });
    await expect(getInstanceIdFromStack('stack', 'us-east-1')).resolves.toBe('i-123');
    expect(cfnSendMock).toHaveBeenCalledTimes(1);
    expect(cfnSendMock.mock.calls[0][0]).toBeInstanceOf(DescribeStacksCommand);
    expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('finds an instance retained by CREATE_FAILED before outputs are available', async () => {
    const instanceId = 'i-0123456789abcdef0';
    cfnSendMock
      .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_FAILED', Outputs: [] }] })
      .mockResolvedValueOnce({
        StackResources: [
          {
            LogicalResourceId: 'PreviousInstance',
            ResourceType: 'AWS::EC2::Instance',
            ResourceStatus: 'DELETE_COMPLETE',
            PhysicalResourceId: 'i-fedcba98765432100',
          },
          {
            LogicalResourceId: 'AnyConstructGeneratedId',
            ResourceType: 'AWS::EC2::Instance',
            ResourceStatus: 'CREATE_FAILED',
            PhysicalResourceId: instanceId,
          },
          {
            ResourceType: 'AWS::IAM::Role',
            ResourceStatus: 'CREATE_COMPLETE',
            PhysicalResourceId: 'role',
          },
        ],
      });

    await expect(getInstanceIdFromStack('stack', 'us-east-1')).resolves.toBe(instanceId);
    expect(cfnSendMock).toHaveBeenCalledTimes(2);
    expect(cfnSendMock.mock.calls[1][0]).toBeInstanceOf(DescribeStackResourcesCommand);
    expect(cfnSendMock.mock.calls[1][0].input).toEqual({ StackName: 'stack' });
    expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
    expect(ec2SendMock).not.toHaveBeenCalled();
    expect(ssmSendMock).not.toHaveBeenCalled();
  });

  it.each([
    { resources: [] },
    {
      resources: [
        {
          ResourceType: 'AWS::EC2::Instance',
          ResourceStatus: 'DELETE_COMPLETE',
          PhysicalResourceId: 'i-0123456789abcdef0',
        },
      ],
    },
    {
      resources: [
        {
          ResourceType: 'AWS::EC2::Instance',
          ResourceStatus: 'CREATE_FAILED',
          PhysicalResourceId: 'i-not-valid',
        },
      ],
    },
    { resources: [{ ResourceType: 'AWS::EC2::Instance', ResourceStatus: 'CREATE_FAILED' }] },
    {
      resources: [
        {
          ResourceType: 'AWS::IAM::Role',
          ResourceStatus: 'CREATE_COMPLETE',
          PhysicalResourceId: 'i-0123456789abcdef0',
        },
      ],
    },
  ])(
    'fails explicitly when outputs and usable EC2 resources are absent: $resources',
    async ({ resources }) => {
      cfnSendMock
        .mockResolvedValueOnce({ Stacks: [{ Outputs: [] }] })
        .mockResolvedValueOnce({ StackResources: resources });
      await expect(getInstanceIdFromStack('stack', 'us-east-1')).rejects.toThrow(
        'Instance ID not found',
      );
      expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects ambiguous nondeleted EC2 resources instead of guessing a target', async () => {
    cfnSendMock.mockResolvedValueOnce({ Stacks: [{ Outputs: [] }] }).mockResolvedValueOnce({
      StackResources: [
        {
          ResourceType: 'AWS::EC2::Instance',
          ResourceStatus: 'CREATE_COMPLETE',
          PhysicalResourceId: 'i-0123456789abcdef0',
        },
        {
          ResourceType: 'AWS::EC2::Instance',
          ResourceStatus: 'CREATE_FAILED',
          PhysicalResourceId: 'i-abcdef01',
        },
      ],
    });
    await expect(getInstanceIdFromStack('stack', 'us-east-1')).rejects.toThrow(
      'Multiple nondeleted EC2 instances',
    );
    expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error('Access denied describing stack resources'), {
      name: 'AccessDeniedException',
    }),
    Object.assign(new Error('Invalid stack identifier'), { name: 'ValidationError' }),
  ])('preserves resource lookup errors and destroys the client: %j', async (error) => {
    cfnSendMock.mockResolvedValueOnce({ Stacks: [{ Outputs: [] }] }).mockRejectedValueOnce(error);
    await expect(getInstanceIdFromStack('stack', 'us-east-1')).rejects.toBe(error);
    expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('translates a missing-stack response from the resource lookup', async () => {
    const error = Object.assign(new Error('Stack with id stack does not exist'), {
      name: 'ValidationError',
    });
    cfnSendMock.mockResolvedValueOnce({ Stacks: [{ Outputs: [] }] }).mockRejectedValueOnce(error);
    await expect(getInstanceIdFromStack('stack', 'us-east-1')).rejects.toMatchObject({
      name: 'StackNotFoundError',
      cause: error,
    });
    expect(cfnDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('resolveInstanceId throws AWSError when not found', async () => {
    cfnSendMock.mockRejectedValue(new Error('no stack'));
    await expect(resolveInstanceId('stack', 'us-east-1')).rejects.toBeInstanceOf(AWSError);
  });

  it('checkSSMStatus returns true when Online', async () => {
    ssmSendMock.mockResolvedValue({
      InstanceInformationList: [{ PingStatus: 'Online' }],
    });
    await expect(checkSSMStatus('i-123', 'us-east-1')).resolves.toBe(true);
  });

  it('checkSSMStatus returns false on error', async () => {
    ssmSendMock.mockRejectedValue(new Error('fail'));
    await expect(checkSSMStatus('i-123', 'us-east-1')).resolves.toBe(false);
  });

  it('getSSMStatus returns not-registered when missing', async () => {
    ssmSendMock.mockResolvedValue({ InstanceInformationList: [] });
    await expect(getSSMStatus('i-123', 'us-east-1')).resolves.toEqual({ status: 'not-registered' });
  });

  it('getSSMStatus returns status and lastPing', async () => {
    ssmSendMock.mockResolvedValue({
      InstanceInformationList: [{ PingStatus: 'Online', LastPingDateTime: new Date('2020-01-01') }],
    });
    const result = await getSSMStatus('i-123', 'us-east-1');
    expect(result.status).toBe('Online');
    expect(result.lastPing).toContain('2020-01-01');
  });

  it('checkGatewayStatus handles active output', async () => {
    ssmSendMock
      .mockResolvedValueOnce({ Command: { CommandId: 'cmd-1' } })
      .mockResolvedValueOnce({ StandardOutputContent: 'active', StandardErrorContent: '' });

    vi.useFakeTimers();
    const run = checkGatewayStatus('i-123', 'us-east-1');
    await vi.runAllTimersAsync();
    const result = await run;
    vi.useRealTimers();

    expect(result.running).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('checkGatewayStatus returns error when command id missing', async () => {
    ssmSendMock.mockResolvedValue({ Command: {} });
    const result = await checkGatewayStatus('i-123', 'us-east-1');
    expect(result.running).toBe(false);
    expect(result.error).toContain('Failed to send command');
  });

  it('waitForSSM returns true when SSM becomes ready', async () => {
    ssmSendMock
      .mockResolvedValueOnce({ InstanceInformationList: [{ PingStatus: 'Offline' }] })
      .mockResolvedValueOnce({ InstanceInformationList: [{ PingStatus: 'Online' }] });

    vi.useFakeTimers();
    const run = waitForSSM('i-123', 'us-east-1', 50, 10);
    await vi.runAllTimersAsync();
    const result = await run;
    vi.useRealTimers();

    expect(result).toBe(true);
  });

  it('getStackStatus returns deployment status with instance info', async () => {
    cfnSendMock
      .mockResolvedValueOnce({
        Stacks: [{ StackName: 'stack', StackStatus: 'CREATE_COMPLETE' }],
      })
      .mockResolvedValueOnce({
        Stacks: [{ Outputs: [{ OutputKey: 'InstanceId', OutputValue: 'i-123' }] }],
      });
    ec2SendMock.mockResolvedValue({
      Reservations: [{ Instances: [{ State: { Name: 'running' } }] }],
    });
    ssmSendMock.mockResolvedValue({
      InstanceInformationList: [{ PingStatus: 'Online' }],
    });

    const status = await getStackStatus('stack', 'us-east-1');
    expect(status.stackStatus).toBe('CREATE_COMPLETE');
    expect(status.instanceId).toBe('i-123');
    expect(status.instanceStatus).toBe('running');
    expect(status.ssmStatus).toBe('ready');
  });

  it('getStackOutputs maps outputs to key/value', async () => {
    cfnSendMock.mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'GatewayUrl', OutputValue: 'https://example.com' }] }],
    });
    const outputs = await getStackOutputs('stack', 'us-east-1');
    expect(outputs.GatewayUrl).toBe('https://example.com');
  });
});
