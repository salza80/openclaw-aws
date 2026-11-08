import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { readCloneCredentialTags } from '../../src/openclaw/clone-credential-readiness.js';

const name = '/openclaw/copy/providers/openrouter-api-key/api-key';
const request = () => ({ abortSignal: AbortSignal.timeout(30000) });
const denied = () => Object.assign(new Error('private SDK context'), { name: 'AccessDenied' });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const client = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as Pick<SSMClient, 'send'>;

describe('clone target credential read readiness', () => {
  it('waits for the same scoped read without replaying any write or changing ownership tags', async () => {
    const tags = { TagList: [{ Key: 'openclaw-aws:restore-id', Value: 'foreign-owner' }] };
    const send = vi.fn().mockRejectedValueOnce(denied()).mockResolvedValue(tags);
    const pending = readCloneCredentialTags(client(send), name, request);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(tags);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls)
      expect(command.input).toEqual({ ResourceType: 'Parameter', ResourceId: name });
    // The caller must reject foreign tags; readiness never adopts or rewrites them.
    expect(send.mock.calls[1][0].constructor.name).toBe('ListTagsForResourceCommand');
  });

  it('bounds a persistent denial and discards SDK request context', async () => {
    const send = vi.fn().mockRejectedValue(denied());
    const pending = expect(readCloneCredentialTags(client(send), name, request)).rejects.toThrow(
      'access did not become available',
    );
    await vi.advanceTimersByTimeAsync(120000);
    await pending;
    expect(send).toHaveBeenCalledTimes(120);
  });

  it('fails immediately on an unknown read error without exposing its message', async () => {
    const send = vi.fn().mockRejectedValue(new Error('private SDK context'));
    await expect(readCloneCredentialTags(client(send), name, request)).rejects.toThrow(
      'ownership could not be read',
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('honors cancellation before another read', async () => {
    const cancel = new AbortController();
    const send = vi.fn().mockRejectedValue(denied());
    const pending = expect(
      readCloneCredentialTags(client(send), name, request, cancel.signal),
    ).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    cancel.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(send).toHaveBeenCalledOnce();
  });
});
