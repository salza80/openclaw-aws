import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  create: vi.fn(),
  register: vi.fn(),
  read: vi.fn(),
  validate: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('prompts', () => ({ default: mocks.prompt }));
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: mocks.target }));
vi.mock('../../src/operations/vault.js', () => ({
  createRecoveryVault: mocks.create,
  readRecoveryVault: mocks.read,
  registerRecoveryVault: mocks.register,
}));
vi.mock('../../src/aws/vault-security.js', async (original) => ({
  ...(await original<typeof import('../../src/aws/vault-security.js')>()),
  validateVaultSecurity: mocks.validate,
}));
import { runVaultCommand } from '../../src/cli/commands/vault.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const target = {
  ...testTarget,
  arn: 'arn:aws:iam::123456789012:role/operator',
  region: 'eu-central-1',
};
const vault = {
  uri: 's3://private-backups/vault/main',
  account: target.account,
  region: target.region,
  key: {
    arn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:independent-abcdef',
    versionId: 'retained-version',
  },
  encryption: {},
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.target.mockResolvedValue(target);
  mocks.create.mockResolvedValue(vault);
  mocks.read.mockResolvedValue(vault);
  mocks.register.mockResolvedValue(vault);
  mocks.validate.mockResolvedValue({});
});
describe('recovery vault CLI', () => {
  it('uses explicit operator profile/region and keeps JSON output free of progress text', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const progress = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runVaultCommand({
        action: 'create',
        locator: 'primary',
        region: target.region,
        profile: 'chosen',
        yes: true,
        json: true,
      });
      expect(mocks.target).toHaveBeenCalledWith({ region: target.region, profile: 'chosen' });
      expect(mocks.create).toHaveBeenCalledExactlyOnceWith(target, 'primary');
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
        uri: vault.uri,
        encryptionMatchesRegistration: true,
      });
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('remain billable'));
    } finally {
      output.mockRestore();
      progress.mockRestore();
    }
  });
  it('inspects a clean-client locator without provisioning or requiring a deployment config', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runVaultCommand({
        action: 'inspect',
        locator: vault.uri,
        region: target.region,
        json: true,
      });
      expect(mocks.read).toHaveBeenCalledWith(target, vault.uri);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.prompt).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });
  it('rejects missing or invalid registration inputs before provisioning or echoing a pasted secret', async () => {
    await expect(
      runVaultCommand({ action: 'register', locator: vault.uri, region: target.region }),
    ).rejects.toThrow(/key-arn/);
    await expect(
      runVaultCommand({ action: 'create', locator: '../bad', region: target.region }),
    ).rejects.toThrow(/Vault name/);
    await expect(
      runVaultCommand({
        action: 'inspect',
        locator: 's3://private-backups/../bad',
        region: target.region,
      }),
    ).rejects.toThrow();
    expect(mocks.target).not.toHaveBeenCalled();
    const output = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      await expect(
        runVaultCommand({
          action: 'register',
          locator: vault.uri,
          region: target.region,
          keyArn: 'PASTED-SECRET-IS-NOT-AN-ARN',
          yes: true,
        }),
      ).rejects.toThrow(/Recovery secret/);
      expect(output).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      error.mockRestore();
    }
  });
});
