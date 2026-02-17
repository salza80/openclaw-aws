import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DescribeInstancesCommandOutput } from '@aws-sdk/client-ec2';
import { AWSError } from '../../src/cli/utils/errors.js';

const mockClient = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
}));

const createEc2ClientMock = vi.hoisted(() => vi.fn(() => mockClient));
const withRetryMock = vi.hoisted(() =>
  vi.fn(async <T>(operation: () => Promise<T>) => operation()),
);

vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createEc2Client: createEc2ClientMock,
}));

vi.mock('../../src/cli/utils/errors.js', async () => {
  const { createErrorsModuleMock } = await import('../helpers/mocks/errors.js');
  return createErrorsModuleMock({ withRetry: withRetryMock });
});

import {
  getInstanceState,
  rebootInstance,
  startInstance,
  stopInstance,
  waitForInstanceState,
} from '../../src/cli/utils/ec2.js';

describe('ec2 utils', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('stops an instance successfully', async () => {
    mockClient.send.mockResolvedValueOnce({});

    await stopInstance('i-stop', 'eu-central-1');

    expect(createEc2ClientMock).toHaveBeenCalledWith('eu-central-1');
    expect(withRetryMock).toHaveBeenCalledWith(expect.any(Function), {
      maxAttempts: 2,
      operationName: 'stop instance',
    });
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    expect(mockClient.send.mock.calls[0][0].constructor.name).toBe('StopInstancesCommand');
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws AWSError when stop fails', async () => {
    withRetryMock.mockRejectedValueOnce(new Error('stop failed'));

    await expect(stopInstance('i-stop', 'eu-central-1')).rejects.toMatchObject({
      name: AWSError.name,
      message: 'Failed to stop instance i-stop',
    });
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('starts an instance successfully', async () => {
    mockClient.send.mockResolvedValueOnce({});

    await startInstance('i-start', 'eu-west-1');

    expect(withRetryMock).toHaveBeenCalledWith(expect.any(Function), {
      maxAttempts: 2,
      operationName: 'start instance',
    });
    expect(mockClient.send.mock.calls[0][0].constructor.name).toBe('StartInstancesCommand');
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws AWSError when start fails', async () => {
    withRetryMock.mockRejectedValueOnce(new Error('start failed'));

    await expect(startInstance('i-start', 'eu-west-1')).rejects.toThrow(
      'Failed to start instance i-start',
    );
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('reboots an instance successfully', async () => {
    mockClient.send.mockResolvedValueOnce({});

    await rebootInstance('i-reboot', 'us-east-1');

    expect(withRetryMock).toHaveBeenCalledWith(expect.any(Function), {
      maxAttempts: 2,
      operationName: 'reboot instance',
    });
    expect(mockClient.send.mock.calls[0][0].constructor.name).toBe('RebootInstancesCommand');
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws AWSError when reboot fails', async () => {
    withRetryMock.mockRejectedValueOnce(new Error('reboot failed'));

    await expect(rebootInstance('i-reboot', 'us-east-1')).rejects.toThrow(
      'Failed to reboot instance i-reboot',
    );
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('gets instance state when describe succeeds', async () => {
    const response: DescribeInstancesCommandOutput = {
      Reservations: [{ Instances: [{ State: { Name: 'running' } }] }],
      $metadata: {},
    };
    mockClient.send.mockResolvedValueOnce(response);

    const state = await getInstanceState('i-state', 'us-east-1');

    expect(state).toBe('running');
    expect(mockClient.send.mock.calls[0][0].constructor.name).toBe('DescribeInstancesCommand');
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when getInstanceState describe fails', async () => {
    mockClient.send.mockRejectedValueOnce(new Error('describe failed'));

    const state = await getInstanceState('i-state', 'us-east-1');

    expect(state).toBeUndefined();
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('waitForInstanceState returns true when desired state is reached', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));

    mockClient.send
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }],
      })
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ State: { Name: 'running' } }] }],
      });

    const pending = waitForInstanceState('i-wait', 'us-east-1', 'running', 10000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result).toBe(true);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('waitForInstanceState returns false after retrying through errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));

    mockClient.send.mockRejectedValue(new Error('temporary error'));

    const pending = waitForInstanceState('i-wait', 'us-east-1', 'running', 1);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result).toBe(false);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });
});
