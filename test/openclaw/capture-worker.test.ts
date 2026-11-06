import { describe, expect, it, vi } from 'vitest';
import { captureInstallation } from '../../src/openclaw/capture-worker.js';
import type { BackupCaptureJob, NativeCaptureSummary } from '../../src/openclaw/backup-contract.js';

const job: BackupCaptureJob = {
  schemaVersion: 1,
  operationId: '11111111-1111-1111-1111-111111111111',
  source: {
    stackId: 'source-stack',
    instanceId: 'i-fixture',
    roleId: 'role',
    account: '123456789012',
    region: 'eu-central-1',
  },
  settings: {
    bucket: 'private-backups',
    prefix: 'vault/main',
    region: 'eu-central-1',
    expectedBucketOwner: '123456789012',
    credentialSource: 'instance-role',
  },
  key: { arn: 'secret', versionId: 'version', versionStage: 'stage' },
  pluginDirectory: '/plugins',
  namespace: 'fixture',
};
const capture: NativeCaptureSummary = {
  createdAt: '2026-11-06T00:00:00.000Z',
  assets: [
    { kind: 'state', sourcePath: '/state' },
    { kind: 'workspace', sourcePath: '/workspace' },
  ],
  agentRoots: [{ agentId: 'main', sourcePath: '/state/agents/main/agent' }],
  skipped: [{ kind: 'config', sourcePath: '/state/openclaw.json', reason: 'covered' }],
  skippedVolatileCount: 0,
  warnings: [],
  location: {
    key: '20261106T000000Z-12345678.tar.gz',
    namespace: 'fixture',
    locationId: 'location',
    plaintextBytes: 100,
    storedBytes: 200,
  },
};
function fixture(initial: 'active' | 'inactive' | 'failed' = 'active') {
  const host = {
    locationName: 'aws-vault',
    runtime: { openclaw: '2026.11.1', node: '24.22.2' },
    gateway: {
      inspect: vi.fn(async () => initial),
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
    },
    prepareStorage: vi.fn(async () => ({ locationId: 'location' })),
    members: vi.fn(async () => [
      { id: 'main', workspace: '/workspace', agentDir: '/state/agents/main/agent' },
    ]),
    capture: vi.fn(async () => structuredClone(capture)),
    credentials: vi.fn(async () => ({
      mode: 'full-native' as const,
      configurationPath: '/state/openclaw.json',
      sourceEnvironmentIncluded: true,
      prerequisites: [],
    })),
    verify: vi.fn(async () => ({
      ok: true as const,
      runtimeVersion: '2026.11.1',
      createdAt: capture.createdAt,
      archiveRoot: 'archive',
      assetCount: 2,
      entryCount: 3,
      symlinkCount: 0,
      sqliteInventoryVerified: true as const,
    })),
    close: vi.fn(async () => {}),
  };
  const storage = {
    identify: vi.fn(async () => {}),
    passphrase: vi.fn(async () => 'private-key'),
    marker: vi.fn(async () => ({ versionId: 'marker-version', storedBytes: 100 })),
    archive: vi.fn(async () => ({ versionId: 'archive-version', storedBytes: 200 })),
    publish: vi.fn(async () => ({ key: 'capture.json', versionId: 'receipt-version' })),
    close: vi.fn(),
  };
  const maintenance = { enter: vi.fn(async (record) => record), release: vi.fn(async () => {}) };
  return {
    host,
    storage,
    maintenance,
    run: () => captureInstallation(job, host, storage, maintenance),
  };
}
describe('host capture recovery barrier', () => {
  it('quiesces, verifies exact remote versions, restores health and only then publishes', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ gatewayRestored: true });
    expect(f.host.verify).toHaveBeenCalledWith(capture.location.key, {
      'openclaw-storage.json': 'marker-version',
      [`backups/fixture/${capture.location.key}`]: 'archive-version',
    });
    expect(f.host.gateway.stop.mock.invocationCallOrder[0]).toBeLessThan(
      f.host.capture.mock.invocationCallOrder[0],
    );
    expect(f.host.verify.mock.invocationCallOrder[0]).toBeLessThan(
      f.host.gateway.start.mock.invocationCallOrder[0],
    );
    expect(f.host.gateway.start.mock.invocationCallOrder[0]).toBeLessThan(
      f.storage.publish.mock.invocationCallOrder[0],
    );
    expect(f.storage.publish.mock.calls[0][0].gateway).toEqual({
      initial: 'active',
      restored: true,
    });
  });
  for (const step of ['prepareStorage', 'members', 'capture', 'credentials', 'verify'] as const) {
    it(`restores the source after ${step} fails and never publishes a point`, async () => {
      const f = fixture();
      f.host[step].mockRejectedValueOnce(Error('private native output or credentials'));
      await expect(f.run()).rejects.toThrow('source service state was restored');
      expect(f.host.gateway.start).toHaveBeenCalledOnce();
      expect(f.maintenance.release).toHaveBeenCalledOnce();
      expect(f.storage.publish).not.toHaveBeenCalled();
      expect(f.host.close).toHaveBeenCalledOnce();
    });
  }
  it('does not alter the service without role identity and maintenance ownership', async () => {
    for (const denied of ['identity', 'ownership']) {
      const f = fixture();
      if (denied === 'identity') f.storage.identify.mockRejectedValueOnce(Error('denied'));
      else f.maintenance.enter.mockRejectedValueOnce(Error('another operation owns maintenance'));
      await expect(f.run()).rejects.toThrow('source service was not changed');
      expect(f.host.gateway.stop).not.toHaveBeenCalled();
      expect(f.host.gateway.start).not.toHaveBeenCalled();
      expect(f.storage.publish).not.toHaveBeenCalled();
    }
  });
  it('attempts restoration even when stopping the service fails', async () => {
    const f = fixture();
    f.host.gateway.stop.mockRejectedValueOnce(Error('timeout'));
    await expect(f.run()).rejects.toThrow('source service state was restored');
    expect(f.host.gateway.start).toHaveBeenCalledOnce();
    expect(f.host.capture).not.toHaveBeenCalled();
  });
  it('retains maintenance ownership after a failed restart, while distinguishing a verified point', async () => {
    const f = fixture();
    f.host.gateway.start.mockRejectedValueOnce(Error('unhealthy'));
    await expect(f.run()).resolves.toMatchObject({ gatewayRestored: false });
    expect(f.maintenance.release).not.toHaveBeenCalled();
    expect(f.storage.publish.mock.calls[0][0].gateway.restored).toBe(false);
  });
  for (const initial of ['inactive', 'failed'] as const) {
    it(`preserves a previously ${initial} service`, async () => {
      const f = fixture(initial);
      await f.run();
      expect(f.host.gateway.stop).not.toHaveBeenCalled();
      expect(f.host.gateway.start).not.toHaveBeenCalled();
    });
  }
  it('refuses missing member workspaces even when native archive verification succeeds', async () => {
    const f = fixture();
    f.host.capture.mockResolvedValueOnce({ ...capture, assets: capture.assets.slice(0, 1) });
    await expect(f.run()).rejects.toThrow('no completed point was published');
    expect(f.host.verify).not.toHaveBeenCalled();
    expect(f.storage.publish).not.toHaveBeenCalled();
  });
  it('refuses a native verification result for a different capture', async () => {
    const f = fixture();
    f.host.verify.mockResolvedValueOnce({ ...(await f.host.verify()), createdAt: 'other' });
    await expect(f.run()).rejects.toThrow('no completed point was published');
    expect(f.storage.publish).not.toHaveBeenCalled();
  });
});
