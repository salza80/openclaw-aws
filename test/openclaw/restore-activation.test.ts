import { describe, expect, it, vi } from 'vitest';
import { activateRestoredService } from '../../src/openclaw/restore-activation.js';
import { RecoveryActivationFailure } from '../../src/openclaw/recovery-service.js';
function fixture() {
  return {
    validate: vi.fn(async () => {}),
    unmaskAndInstall: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    health: vi.fn(async () => {}),
    maskInactive: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  };
}
describe('deliberate restored Gateway activation', () => {
  it('validates before installation, then checks health and validates holds again', async () => {
    const host = fixture();
    await activateRestoredService(host);
    expect(host.validate).toHaveBeenCalledTimes(2);
    expect(host.start).toHaveBeenCalledOnce();
    expect(host.validate.mock.invocationCallOrder[0]).toBeLessThan(
      host.unmaskAndInstall.mock.invocationCallOrder[0],
    );
    expect(host.health.mock.invocationCallOrder[0]).toBeLessThan(
      host.validate.mock.invocationCallOrder[1],
    );
    expect(host.maskInactive).not.toHaveBeenCalled();
  });
  it('does not remove the service hold if safety validation fails', async () => {
    const host = fixture();
    host.validate.mockRejectedValueOnce(new Error('sessions changed'));
    await expect(activateRestoredService(host)).rejects.toThrow('sessions changed');
    expect(host.unmaskAndInstall).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
  });
  it('restores the inactive mask after install, start, health or post-start validation failure', async () => {
    for (const phase of ['unmaskAndInstall', 'start', 'health', 'validate', 'commit'] as const) {
      const host = fixture();
      if (phase === 'validate')
        host.validate
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('hold changed'));
      else host[phase].mockRejectedValueOnce(new Error('private failure'));
      const error = await activateRestoredService(host).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RecoveryActivationFailure);
      expect(error).toMatchObject({
        phase:
          phase === 'unmaskAndInstall' ? 'install' : phase === 'validate' ? 'revalidate' : phase,
        inactiveVerified: true,
      });
      expect(JSON.stringify(error)).not.toContain('private failure');
      expect(host.maskInactive).toHaveBeenCalledOnce();
    }
  });
  it('reports uncertainty when failed activation cannot reestablish the hold', async () => {
    const host = fixture();
    host.health.mockRejectedValueOnce(new Error('not ready'));
    host.maskInactive.mockRejectedValueOnce(new Error('service manager unavailable'));
    await expect(activateRestoredService(host)).rejects.toMatchObject({
      phase: 'health',
      inactiveVerified: false,
    });
  });
});
