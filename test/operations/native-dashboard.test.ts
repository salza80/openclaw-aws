import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  ssm: vi.fn(),
  gateway: vi.fn(),
  secret: vi.fn(),
  tunnel: vi.fn(),
  open: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../src/aws/recovery-source.js', () => ({ inspectRecoverySource: mocks.source }));
vi.mock('../../src/cli/utils/aws.js', () => ({
  checkSSMStatus: mocks.ssm,
  checkGatewayStatus: mocks.gateway,
}));
vi.mock('../../src/cli/utils/aws-validation.js', () => ({ validateSSMPlugin: async () => {} }));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: () => ({ send: mocks.secret, destroy() {} }),
}));
vi.mock('../../src/aws/tunnel.js', () => ({ startDashboardTunnel: mocks.tunnel }));
vi.mock('execa', () => ({ execa: mocks.open }));
import { prepareNativeDashboard, openLocalBrowser } from '../../src/operations/native-dashboard.js';
const ctx = makeCommandContext();
const token = 'a'.repeat(48);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.source.mockResolvedValue({ instanceId: 'i-approved' });
  mocks.ssm.mockResolvedValue(true);
  mocks.gateway.mockResolvedValue({ running: true });
  mocks.secret.mockResolvedValue({
    Parameter: { Name: '/openclaw/alpha/gateway-token', Type: 'SecureString', Value: token },
  });
  mocks.tunnel.mockResolvedValue({ port: 19444, stop: mocks.stop, done: Promise.resolve() });
  mocks.open.mockResolvedValue({ failed: false });
});
describe('shared native UI access', () => {
  it('keeps the token out of ordinary metadata and gives it only to the explicit native browser handoff', async () => {
    const session = await prepareNativeDashboard(ctx);
    expect(JSON.stringify(session)).not.toContain(token);
    expect(session.browserUrl(false)).toBe('http://localhost:19444');
    await session.open();
    expect(mocks.open.mock.calls[0][1].join(' ')).toContain('#token=' + token);
    expect(mocks.tunnel).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'i-approved', target: ctx.target }),
    );
  });
  it('does not fetch a token or open a tunnel for an unready Gateway', async () => {
    mocks.gateway.mockResolvedValueOnce({ running: false });
    await expect(prepareNativeDashboard(ctx)).rejects.toThrow('health is unavailable');
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.tunnel).not.toHaveBeenCalled();
  });
  it('rejects an unexpected secret and arbitrary external browser URLs', async () => {
    mocks.secret.mockResolvedValueOnce({
      Parameter: { Name: '/another/token', Type: 'SecureString', Value: token },
    });
    await expect(prepareNativeDashboard(ctx)).rejects.toThrow('credential is unavailable');
    await expect(openLocalBrowser('https://example.com')).rejects.toThrow('owned local');
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
