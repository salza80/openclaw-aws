import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneRecordFixture, clonePreviewFixture } from '../helpers/fixtures/clone.js';
import { backupReceipt } from '../helpers/fixtures/backup.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  prepare: vi.fn(),
  stage: vi.fn(),
  resume: vi.fn(),
  load: vi.fn(),
  cleanup: vi.fn(),
  print: vi.fn(),
  error: vi.fn(),
  ssm: vi.fn(),
}));
vi.mock('../../src/aws/target.js', () => ({ resolveAwsTarget: mocks.target }));
vi.mock('../../src/operations/clone.js', () => ({
  prepareClone: mocks.prepare,
  stageClone: mocks.stage,
  resumeClone: mocks.resume,
  cleanupClone: mocks.cleanup,
}));
vi.mock('../../src/operations/clone-record.js', async (load) => ({
  ...(await load<object>()),
  loadCloneRecord: mocks.load,
}));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: () => ({ send: mocks.ssm, destroy: vi.fn() }),
}));
import { runCloneCommand, cloneCredentialSources } from '../../src/cli/commands/clone.js';
const record = cloneRecordFixture();
const target = { ...testTarget, arn: 'arn:aws:sts::123456789012:assumed-role/operator/session' };
const args = {
  from: backupReceipt.id,
  vault: backupReceipt.vaultUri,
  region: 'eu-central-1',
  name: record.name,
  yes: true,
  json: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(mocks.print);
  vi.spyOn(console, 'error').mockImplementation(mocks.error);
  vi.stubEnv('EXPLICIT_CLONE_TEST_KEY', 'private-target-value');
  vi.stubEnv('OPENROUTER_API_KEY', 'ambient-must-not-be-used');
  mocks.target.mockResolvedValue(target);
  mocks.prepare.mockResolvedValue({
    operationId: record.operationId,
    bootstrap: record.bootstrap,
    preview: clonePreviewFixture(),
    context: { name: record.name, config: record.config, target },
  });
  mocks.stage.mockResolvedValue(record);
  mocks.resume.mockResolvedValue({ ...record, phase: 'active' });
  mocks.load.mockReturnValue(structuredClone(record));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('clone CLI', () => {
  it('previews the whole team without credentials, approval or target provisioning', async () => {
    await runCloneCommand({ ...args, action: 'preview', yes: false });
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.ssm).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.print.mock.calls[0][0]).preview.scope).toBe('whole-team-knowledge');
  });
  it('passes only explicit credentials privately and keeps activation separate', async () => {
    await runCloneCommand({ ...args, keyEnv: 'EXPLICIT_CLONE_TEST_KEY' });
    expect(mocks.stage.mock.calls[0][2]).toEqual({ 'openrouter-api-key': 'private-target-value' });
    expect(mocks.resume).not.toHaveBeenCalled();
    const published = JSON.stringify([...mocks.print.mock.calls, ...mocks.error.mock.calls]);
    expect(published).not.toContain('private-target-value');
    expect(published).not.toContain('ambient-must-not-be-used');
    expect(published).toContain('omitted paths');
  });
  it('resolves explicit SecureString reuse without publishing raw SDK data', async () => {
    mocks.ssm.mockResolvedValueOnce({
      Parameter: {
        Name: '/source/model-key',
        Type: 'SecureString',
        Value: 'private-selected-source-key',
      },
    });
    await runCloneCommand({ ...args, reuseSsm: '/source/model-key', activate: true });
    expect(mocks.stage.mock.calls[0][2]).toEqual({
      'openrouter-api-key': 'private-selected-source-key',
    });
    expect(mocks.resume).toHaveBeenCalledWith(
      record.operationId,
      expect.objectContaining({ activate: true }),
    );
    expect(JSON.stringify(mocks.print.mock.calls)).not.toContain('private-selected-source-key');
    mocks.ssm.mockRejectedValueOnce(new Error('sensitive SDK details'));
    await expect(runCloneCommand({ ...args, reuseSsm: '/source/model-key' })).rejects.toThrow(
      'could not be resolved',
    );
  });
  it('requires each used provider explicitly and never falls back to ambient credentials', async () => {
    await expect(runCloneCommand(args)).rejects.toThrow('explicit --credential-env');
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it('requires noninteractive mutation approval and rejects conflicting or literal key references', async () => {
    await expect(
      runCloneCommand({ ...args, keyEnv: 'EXPLICIT_CLONE_TEST_KEY', yes: false }),
    ).rejects.toThrow('--yes');
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(() =>
      cloneCredentialSources({ keyEnv: 'KEY', reuseSsm: '/key' }, 'openrouter-api-key'),
    ).toThrow('exactly one');
    expect(() =>
      cloneCredentialSources({ keyEnv: 'sk-private-literal' }, 'openrouter-api-key'),
    ).toThrow('references');
  });
  it('inspects only recorded metadata and refuses target overrides or credential changes after staging', async () => {
    await runCloneCommand({ action: 'inspect', operationId: record.operationId, json: true });
    expect(mocks.target).not.toHaveBeenCalled();
    const output = JSON.parse(mocks.print.mock.calls[0][0]);
    expect(output.recordedPhase).toBe('ready-inactive');
    expect(output).not.toHaveProperty('delivery');
    await expect(
      runCloneCommand({
        action: 'resume',
        operationId: record.operationId,
        region: 'us-east-1',
        yes: true,
      }),
    ).rejects.toThrow('pinned target');
    await expect(
      runCloneCommand({
        action: 'resume',
        operationId: record.operationId,
        keyEnv: 'EXPLICIT_CLONE_TEST_KEY',
        yes: true,
      }),
    ).rejects.toThrow('already certified');
  });
  it('reports cleanup with backup retention and no activation', async () => {
    await runCloneCommand({
      action: 'cleanup',
      operationId: record.operationId,
      yes: true,
      json: true,
    });
    expect(mocks.cleanup).toHaveBeenCalledWith(record.operationId);
    expect(JSON.parse(mocks.print.mock.calls[0][0]).sourceAndBackupRetained).toBe(true);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});
