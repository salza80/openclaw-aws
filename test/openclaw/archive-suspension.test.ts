import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareArchiveSuspension,
  assertArchiveSuspension,
  resumeArchiveSuspension,
  type ArchiveSuspension,
} from '../../src/openclaw/archive-suspension.js';

const operationId = '11111111-1111-1111-1111-111111111111';
const lease: ArchiveSuspension = {
  requestId: `openclaw-aws-archive:${operationId}`,
  suspensionId: '22222222-2222-2222-2222-222222222222',
  expiresAtMs: Date.parse('2026-11-06T00:02:00Z'),
};
const ready = () => ({
  status: 'ready',
  activeCount: 0,
  blockers: [],
  writeCustody: [],
  suspensionId: lease.suspensionId,
  expiresAtMs: lease.expiresAtMs,
});
const status = () => ({
  status: 'ready',
  ownerId: lease.requestId,
  expiresAtMs: lease.expiresAtMs,
  writeCustody: [],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());
describe('cooperative archive suspension', () => {
  it('uses an explicit preserved-work lease and reads ownership before permitting handoff', async () => {
    const call = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce(status());
    await expect(prepareArchiveSuspension({ call }, operationId)).resolves.toEqual(lease);
    expect(call.mock.calls).toEqual([
      ['gateway.suspend.prepare', { requestId: lease.requestId, terminalPolicy: 'preserve' }],
      ['gateway.suspend.status', { suspensionId: lease.suspensionId, includeLifecycle: true }],
    ]);
  });
  it('refuses invalid operation ownership before issuing a native request', async () => {
    const call = vi.fn();
    await expect(prepareArchiveSuspension({ call }, 'not-an-operation')).rejects.toThrow(/UUID/);
    await expect(
      resumeArchiveSuspension({ call }, { ...lease, requestId: 'foreign' }),
    ).rejects.toThrow(/ownership/);
    expect(call).not.toHaveBeenCalled();
  });
  it.each(['busy', 'draining'])(
    'preserves %s work without retrying or resuming it',
    async (state) => {
      const call = vi.fn().mockResolvedValue({
        status: state,
        activeCount: 1,
        blockers: [{ kind: 'root-request', count: 1, message: 'private native diagnostic' }],
      });
      const result = prepareArchiveSuspension({ call }, operationId);
      await expect(result).rejects.toThrow(/active work/);
      await expect(result).rejects.not.toThrow(/private native/);
      expect(call).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { writeCustody: [{ kind: 'terminal', count: 1 }] },
    { writeCustody: undefined },
    { activeCount: 1 },
    { blockers: [{ kind: 'worker', count: 1 }] },
  ])('refuses an inconsistent idle claim: %j', async (change) => {
    const call = vi.fn().mockResolvedValue({ ...ready(), ...change });
    await expect(prepareArchiveSuspension({ call }, operationId)).rejects.toThrow(/custody/);
    expect(call).toHaveBeenCalledOnce();
  });
  it('requires enough remaining native lease time before every inactive handoff', async () => {
    const call = vi.fn().mockResolvedValue({ ...status(), expiresAtMs: Date.now() + 29999 });
    await expect(assertArchiveSuspension({ call }, lease)).rejects.toThrow(/insufficient time/);
    expect(call).toHaveBeenCalledOnce();
  });
  it('does not stop or release a foreign suspension after a Gateway/owner change', async () => {
    const call = vi.fn().mockResolvedValue({ ...status(), ownerId: 'foreign' });
    await expect(assertArchiveSuspension({ call }, lease)).rejects.toThrow(/ownership changed/);
    await expect(resumeArchiveSuspension({ call }, lease)).rejects.toThrow(/no resume/);
    expect(call.mock.calls.every(([method]) => method === 'gateway.suspend.status')).toBe(true);
  });
  it('does not reacquire an expired suspension', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'running' });
    await expect(resumeArchiveSuspension({ call }, lease)).resolves.toBe(false);
    expect(call).toHaveBeenCalledOnce();
  });
  it('can release an owned lease near expiry without requiring another idle lease', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ...status(), expiresAtMs: Date.now() + 1 })
      .mockResolvedValueOnce({ ok: true, status: 'running', resumed: true });
    await expect(resumeArchiveSuspension({ call }, lease)).resolves.toBe(true);
    expect(call.mock.calls[1]).toEqual([
      'gateway.suspend.resume',
      { suspensionId: lease.suspensionId },
    ]);
  });
  it('keeps a lost/invalid resume outcome uncertain instead of repeating the write', async () => {
    const call = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce({ ok: false });
    await expect(resumeArchiveSuspension({ call }, lease)).rejects.toThrow(/not confirmed/);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
