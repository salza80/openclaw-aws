import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
} from '@aws-sdk/client-ssm';
const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({ createSsmClient: () => mocks }));
import { executeSsm, RemoteCommandError } from '../../src/aws/ssm.js';
import { asUbuntu, openclawJson, shellQuote } from '../../src/openclaw/commands.js';
const success = { Status: 'Success', ResponseCode: 0, StandardOutputContent: '{"ok":true}' };
beforeEach(() => {
  mocks.send.mockResolvedValueOnce({ Command: { CommandId: 'command' } });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
describe('bounded SSM execution', () => {
  it('waits through eventual delivery and transient statuses, then checks the exit code', async () => {
    mocks.send
      .mockRejectedValueOnce(
        Object.assign(new Error('pending'), { name: 'InvocationDoesNotExist' }),
      )
      .mockResolvedValueOnce({ Status: 'Pending' })
      .mockResolvedValueOnce({ Status: 'Delayed' })
      .mockResolvedValueOnce({ Status: 'Cancelling' })
      .mockResolvedValueOnce(success);
    expect(
      await executeSsm('i-test', 'eu-central-1', ['echo private'], {
        executionSeconds: 10,
        pollMs: 0,
      }),
    ).toEqual({ stdout: '{"ok":true}', stderr: '', commandId: 'command' });
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(SendCommandCommand);
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({
      TimeoutSeconds: 30,
      Parameters: { executionTimeout: ['10'] },
    });
    expect(mocks.send.mock.calls[1][0]).toBeInstanceOf(GetCommandInvocationCommand);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it.each(['Failed', 'Cancelled', 'TimedOut'])(
    'rejects terminal %s without leaking output',
    async (status) => {
      mocks.send.mockResolvedValueOnce({ Status: status, StandardErrorContent: 'secret' });
      await expect(executeSsm('i-test', 'eu-central-1', ['private'])).rejects.toMatchObject({
        name: 'RemoteCommandError',
        status,
        message: expect.not.stringContaining('secret'),
      });
      expect(mocks.send).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    { ...success, ResponseCode: 1 },
    { ...success, ResponseCode: undefined },
    { ...success, StandardOutputContent: 'x'.repeat(24000) },
    { ...success, StandardErrorContent: 'x'.repeat(8000) },
    { ...success, StandardOutputUrl: 'https://example.com/output' },
  ])('rejects unusable or truncated results', async (response) => {
    mocks.send.mockResolvedValueOnce(response);
    await expect(executeSsm('i-test', 'eu-central-1', ['private'])).rejects.toBeInstanceOf(
      RemoteCommandError,
    );
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('cancels delivery after local cancellation and releases the client', async () => {
    const controller = new AbortController();
    mocks.send
      .mockImplementationOnce(async () => {
        controller.abort();
        return { Status: 'Pending' };
      })
      .mockResolvedValue({});
    await expect(
      executeSsm('i-test', 'eu-central-1', ['private'], { signal: controller.signal, pollMs: 0 }),
    ).rejects.toThrow();
    expect(mocks.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(CancelCommandCommand);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('cancels on an expired local deadline and preserves API errors', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 100_000);
    mocks.send.mockResolvedValue({});
    await expect(
      executeSsm('i-test', 'eu-central-1', ['private'], { executionSeconds: 1 }),
    ).rejects.toThrow('Timed out');
    expect(mocks.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(CancelCommandCommand);
  });
  it('preserves access errors rather than treating them as absence', async () => {
    const error = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    mocks.send.mockRejectedValueOnce(error).mockResolvedValue({});
    await expect(executeSsm('i-test', 'eu-central-1', ['private'])).rejects.toBe(error);
    expect(mocks.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(CancelCommandCommand);
  });
});
describe('native OpenClaw boundary', () => {
  it('checks complete JSON and quotes native arguments', async () => {
    mocks.send.mockResolvedValueOnce(success);
    expect(await openclawJson('i-test', 'eu-central-1', ['health', 'value; $(bad)'])).toEqual({
      ok: true,
    });
    const command = mocks.send.mock.calls[0][0].input.Parameters.commands[0];
    expect(command).toContain(shellQuote(shellQuote('value; $(bad)')).slice(1, -1));
  });
  it('rejects malformed JSON without printing it', async () => {
    mocks.send.mockResolvedValueOnce({ ...success, StandardOutputContent: 'private partial json' });
    await expect(openclawJson('i-test', 'eu-central-1', ['health'])).rejects.toThrow(
      'invalid JSON',
    );
  });
  it('sets the native service user, dynamic UID and private-prefix/NVM paths', () => {
    const command = asUbuntu('openclaw health --json');
    expect(command).toContain('sudo -H -u ubuntu');
    expect(command).toContain('HOME=/home/ubuntu');
    expect(command).toContain('$(id -u)');
    expect(command).toContain('.openclaw/tools/node/bin');
    expect(command).toContain('.nvm/nvm.sh');
    expect(command).not.toContain('/run/user/1000');
  });
});
