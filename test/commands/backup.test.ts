import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCommandContext, testTarget } from '../helpers/fixtures/command-context.js';
import { backupId, backupReceipt, backupVault } from '../helpers/fixtures/backup.js';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  target: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  inspect: vi.fn(),
  verify: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: mocks.target }));
vi.mock('../../src/operations/backup.js', async (original) => ({
  ...(await original<typeof import('../../src/operations/backup.js')>()),
  createBackup: mocks.create,
  listBackups: mocks.list,
  inspectBackup: mocks.inspect,
  verifyBackup: mocks.verify,
}));
vi.mock('prompts', () => ({ default: mocks.prompt }));
import { runBackupCommand } from '../../src/cli/commands/backup.js';
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.context.mockResolvedValue(makeCommandContext());
  mocks.target.mockResolvedValue(testTarget);
  mocks.create.mockResolvedValue(backupReceipt);
  mocks.list.mockResolvedValue([backupReceipt]);
  mocks.inspect.mockResolvedValue(backupReceipt);
  mocks.verify.mockResolvedValue({ id: backupId, verified: true });
});
describe('backup CLI boundary', () => {
  it('creates through the shared operation with the named deployment target', async () => {
    await runBackupCommand({
      action: 'create',
      name: 'alpha',
      vault: backupVault.uri,
      yes: true,
      json: true,
      operationId: backupId,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alpha' }),
      expect.objectContaining({ vaultUri: backupVault.uri, operationId: backupId }),
    );
    expect(mocks.target).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({ id: backupId });
    expect(console.error).toHaveBeenCalled();
  });
  for (const action of ['list', 'inspect', 'verify']) {
    it(`supports clean-client ${action} without any source config`, async () => {
      await runBackupCommand({
        action,
        ...(action === 'list' ? {} : { id: backupId }),
        vault: backupVault.uri,
        region: 'eu-central-1',
        profile: 'recovery',
        json: true,
      });
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.target).toHaveBeenCalledWith({ region: 'eu-central-1', profile: 'recovery' });
      expect(console.log).toHaveBeenCalledTimes(1);
    });
  }
  it('requires explicit region and recovery point for independent reads', async () => {
    await expect(runBackupCommand({ action: 'list', vault: backupVault.uri })).rejects.toThrow(
      '--region',
    );
    await expect(
      runBackupCommand({ action: 'verify', vault: backupVault.uri, region: 'eu-central-1' }),
    ).rejects.toThrow('explicit recovery point');
    expect(mocks.target).not.toHaveBeenCalled();
  });
  it('refuses target overrides when capturing a named deployment', async () => {
    await expect(
      runBackupCommand({
        action: 'create',
        vault: backupVault.uri,
        region: 'eu-central-1',
        yes: true,
      }),
    ).rejects.toThrow('named deployment');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('refuses native latest aliases and malformed locators before AWS calls', async () => {
    await expect(
      runBackupCommand({
        action: 'inspect',
        id: 'latest',
        vault: backupVault.uri,
        region: 'eu-central-1',
      }),
    ).rejects.toThrow('operation ID');
    await expect(
      runBackupCommand({ action: 'create', vault: 's3://bucket/../unsafe', yes: true }),
    ).rejects.toThrow('key');
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.target).not.toHaveBeenCalled();
  });
});
