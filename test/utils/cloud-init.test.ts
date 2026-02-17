import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());
const destroyMock = vi.hoisted(() => vi.fn());
const createEc2ClientMock = vi.hoisted(() => vi.fn());
const withRetryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createEc2Client: createEc2ClientMock,
}));

vi.mock('../../src/cli/utils/errors.js', () => ({
  withRetry: withRetryMock,
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  GetConsoleOutputCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

import {
  checkCloudInitStatus,
  getConsoleOutput,
  getInstallationProgress,
} from '../../src/cli/utils/cloud-init.js';

describe('cloud-init utils', () => {
  beforeEach(() => {
    createEc2ClientMock.mockReturnValue({
      send: sendMock,
      destroy: destroyMock,
    });
    withRetryMock.mockImplementation(async (operation: () => Promise<unknown>) => operation());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses complete cloud-init output with elapsed time and successful install', async () => {
    sendMock.mockResolvedValue({
      Output:
        'Cloud-init v. 22.2 started at 2025-01-01T10:00:00Z. OpenClaw CLI installed successfully finished at 2025-01-01T10:12:00Z.',
    });

    const result = await checkCloudInitStatus('i-123', 'us-east-1');

    expect(createEc2ClientMock).toHaveBeenCalledWith('us-east-1');
    expect(withRetryMock).toHaveBeenCalledWith(expect.any(Function), {
      maxAttempts: 2,
      operationName: 'get console output',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual({
      InstanceId: 'i-123',
      Latest: true,
    });
    expect(result).toEqual({
      isComplete: true,
      hasError: false,
      isOpenClawInstalled: true,
      errorMessage: undefined,
      elapsedMinutes: 12,
    });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('detects non-fatal completion despite error-like output', async () => {
    sendMock.mockResolvedValue({
      Output:
        'Cloud-init v. 22.2 started at 2025-01-01T10:00:00Z. Error: transient failure finished at 2025-01-01T10:01:00Z.',
    });

    const result = await checkCloudInitStatus('i-123', 'us-east-1');

    expect(result.hasError).toBe(false);
    expect(result.errorMessage).toBeUndefined();
    expect(result.isComplete).toBe(true);
  });

  it('detects in-progress fatal errors and parses npm error message', async () => {
    sendMock.mockResolvedValue({
      Output: 'npm error network timeout\nopenclaw@1.2.3\n2 packages added',
    });

    const result = await checkCloudInitStatus('i-123', 'us-east-1');

    expect(result).toEqual({
      isComplete: false,
      hasError: true,
      isOpenClawInstalled: true,
      errorMessage: 'network timeout',
      elapsedMinutes: undefined,
    });
  });

  it('parses Error: message when cloud-init has not completed', async () => {
    sendMock.mockResolvedValue({
      Output: 'Error: disk full while installing packages',
    });

    const result = await checkCloudInitStatus('i-123', 'us-east-1');

    expect(result).toEqual({
      isComplete: false,
      hasError: true,
      isOpenClawInstalled: false,
      errorMessage: 'disk full while installing packages',
      elapsedMinutes: undefined,
    });
  });

  it('handles empty console output without errors', async () => {
    sendMock.mockResolvedValue({});

    await expect(checkCloudInitStatus('i-123', 'us-east-1')).resolves.toEqual({
      isComplete: false,
      hasError: false,
      isOpenClawInstalled: false,
      errorMessage: undefined,
      elapsedMinutes: undefined,
    });
  });

  it('returns default not-ready status when console output retrieval fails', async () => {
    withRetryMock.mockRejectedValueOnce(new Error('boom'));

    await expect(checkCloudInitStatus('i-123', 'us-east-1')).resolves.toEqual({
      isComplete: false,
      hasError: false,
      isOpenClawInstalled: false,
    });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('returns console output content when available', async () => {
    sendMock.mockResolvedValue({ Output: 'console output text' });

    await expect(getConsoleOutput('i-456', 'us-west-2')).resolves.toBe('console output text');
    expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual({
      InstanceId: 'i-456',
      Latest: true,
    });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty string when console output is missing', async () => {
    sendMock.mockResolvedValue({});
    await expect(getConsoleOutput('i-456', 'us-west-2')).resolves.toBe('');
  });

  it('returns empty string from getConsoleOutput on failure', async () => {
    withRetryMock.mockRejectedValueOnce(new Error('fail'));
    await expect(getConsoleOutput('i-456', 'us-west-2')).resolves.toBe('');
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('reports installation complete progress', () => {
    expect(getInstallationProgress('OpenClaw CLI installed successfully')).toBe(
      'OpenClaw installation complete ✅',
    );
  });

  it('reports openclaw install in progress', () => {
    expect(getInstallationProgress('npm install -g openclaw')).toBe(
      'Installing OpenClaw CLI... (this takes 5-10 minutes)',
    );
  });

  it('reports node installation in progress', () => {
    expect(getInstallationProgress('Installing nodejs package')).toBe('Installing Node.js...');
  });

  it('reports NodeSource setup in progress', () => {
    expect(getInstallationProgress('NodeSource repository script')).toBe(
      'Setting up Node.js repository...',
    );
  });

  it('reports system update progress', () => {
    expect(getInstallationProgress('apt-get update -y')).toBe('Updating system packages...');
  });

  it('reports startup fallback progress', () => {
    expect(getInstallationProgress('booting')).toBe('Instance starting up...');
  });
});
