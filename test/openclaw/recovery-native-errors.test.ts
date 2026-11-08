import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execa: vi.fn() }));
vi.mock('execa', () => ({ execa: mocks.execa }));
import {
  activateRecoveryService,
  createRecoveryServiceHost,
  RecoveryActivationFailure,
} from '../../src/openclaw/recovery-service.js';

beforeEach(() => vi.resetAllMocks());
describe('private native activation error projection', () => {
  it.each([
    ['SERVICE_DEFINITION_UNKNOWN: private-provider-key', 'service-definition'],
    ['SERVICE_DEFINITION_SEALED: private-provider-key', 'service-definition'],
    ['Runtime pin inspection failed: private-provider-key', 'runtime-pin'],
    ['Config invalid: private-provider-key', 'configuration'],
    ['systemd-user-bus-unavailable: private-provider-key', 'service-manager'],
    ['unrecognized diagnostic private-provider-key', 'unclassified'],
  ])(
    'retains a fixed category for %s without retaining native context',
    async (stdout, category) => {
      mocks.execa.mockImplementation(async (command: string) => {
        if (command === 'systemctl') return {};
        throw Object.assign(new Error('private-provider-key'), {
          stdout,
          stderr: 'private-provider-key',
          env: { OPENROUTER_API_KEY: 'private-provider-key' },
        });
      });
      const host = createRecoveryServiceHost({
        home: '/home/ubuntu',
        work: '/home/ubuntu/.openclaw-aws/jobs/fixture',
        packageJson: '/home/ubuntu/.openclaw/tools/node/lib/node_modules/openclaw/package.json',
        gatewayToken: 'a'.repeat(48),
        validate: vi.fn(async () => {}),
        assertInactive: vi.fn(async () => {}),
      });
      host.maskInactive = vi.fn(async () => {});
      const error = await activateRecoveryService(host).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RecoveryActivationFailure);
      expect(error).toMatchObject({
        phase: 'install',
        inactiveVerified: true,
        nativeCategory: category,
      });
      expect(String(error)).not.toContain('private-provider-key');
      expect(JSON.stringify(error)).not.toContain('private-provider-key');
      expect(error).not.toHaveProperty('cause');
      expect(host.maskInactive).toHaveBeenCalledOnce();
      expect(mocks.execa).toHaveBeenCalledTimes(2);
    },
  );
});
