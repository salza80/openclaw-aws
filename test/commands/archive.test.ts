import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCommandContext } from '../helpers/fixtures/command-context.js';
import { backupId, backupSource, backupVault, backupCapture } from '../helpers/fixtures/backup.js';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  plan: vi.fn(),
  create: vi.fn(),
  inspect: vi.fn(),
  resume: vi.fn(),
  abort: vi.fn(),
}));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/operations/archive.js', () => ({
  planArchive: mocks.plan,
  createArchive: mocks.create,
  inspectArchive: mocks.inspect,
  resumeArchive: mocks.resume,
  abortArchive: mocks.abort,
}));
import { runArchiveCommand } from '../../src/cli/commands/archive.js';
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  const ctx = makeCommandContext();
  mocks.context.mockResolvedValue(ctx);
  mocks.plan.mockResolvedValue({
    operationId: backupId,
    name: ctx.name,
    config: ctx.config,
    vaultUri: backupVault.uri,
    deleteConfig: true,
    expectedMembers: backupCapture.members,
    deletion: { source: backupSource, volumeId: 'vol-0123456789abcdef0', parameters: [] },
  });
  mocks.create.mockResolvedValue({ operationId: backupId, recordedPhase: 'archived' });
  mocks.inspect.mockResolvedValue({ operationId: backupId, recordedPhase: 'verified-held' });
  mocks.resume.mockResolvedValue({ operationId: backupId, recordedPhase: 'archived' });
  mocks.abort.mockResolvedValue({ operationId: backupId, recordedPhase: 'aborted' });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalTty) Object.defineProperty(process.stdin, 'isTTY', originalTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
});
describe('archive command approval and recovery boundary', () => {
  it('displays the concrete whole-host plan before explicit teardown approval', async () => {
    await runArchiveCommand({
      name: 'alpha',
      vault: backupVault.uri,
      operationId: backupId,
      yes: true,
      json: true,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alpha' }),
      await mocks.plan.mock.results[0].value,
    );
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0])).toMatchObject({
      sourceStackId: backupSource.stackId,
      operationId: backupId,
    });
    expect(console.log).toHaveBeenCalledOnce();
  });
  it('requires explicit noninteractive approval after preview, without running archive', async () => {
    await expect(runArchiveCommand({ vault: backupVault.uri })).rejects.toThrow('--yes');
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['inspect', 'resume', 'abort'] as const)(
    'supports clean-client %s without loading a deployment config',
    async (action) => {
      await runArchiveCommand({
        action,
        vault: backupVault.uri,
        operationId: backupId,
        region: 'eu-central-1',
        profile: 'recovery',
        yes: action !== 'inspect',
        json: true,
      });
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks[action]).toHaveBeenCalledWith({
        vaultUri: backupVault.uri,
        operationId: backupId,
        region: 'eu-central-1',
        profile: 'recovery',
      });
    },
  );
  it('refuses recovery without an explicit operation/region and creation target overrides', async () => {
    await expect(
      runArchiveCommand({ action: 'resume', vault: backupVault.uri, yes: true }),
    ).rejects.toThrow('--operation-id');
    await expect(
      runArchiveCommand({ vault: backupVault.uri, region: 'eu-central-1', yes: true }),
    ).rejects.toThrow('named deployment');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});
