import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  inspect: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('../../src/cli/utils/context.js', () => ({ buildCommandContext: mocks.context }));
vi.mock('../../src/operations/bedrock.js', () => ({
  prepareBedrockConnection: mocks.prepare,
  applyBedrockConnection: mocks.apply,
  cancelBedrockConnection: mocks.cancel,
  inspectBedrockConnection: mocks.inspect,
}));
vi.mock('prompts', () => ({ default: mocks.prompt }));
import { runProvidersCommand } from '../../src/cli/commands/providers.js';
import { bedrockJob } from '../helpers/bedrock-operation.js';
const plan = {
  job: bedrockJob,
  access: { stackName: 'auxiliary-policy' },
  selection: { routes: [] },
};
const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  mocks.context.mockResolvedValue({
    name: 'test',
    target: { account: bedrockJob.target.account, region: 'eu-central-1' },
  });
  mocks.prepare.mockResolvedValue(plan);
  mocks.apply.mockResolvedValue({ phase: 'complete' });
  mocks.inspect.mockResolvedValue({ phase: 'uncertain', observed: null });
});
afterEach(() => {
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.restoreAllMocks();
});
describe('provider CLI boundary', () => {
  it('prints a dry-run preview and discards the unexecuted exact IAM review', async () => {
    await runProvidersCommand({
      action: 'enable-bedrock',
      inferenceRegion: 'eu-central-1',
      dryRun: true,
    });
    expect(mocks.cancel).toHaveBeenCalledWith(expect.anything(), plan);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      reviewDiscarded: true,
    });
  });
  it('applies only the displayed consent/restart plan after explicit approval', async () => {
    await runProvidersCommand({
      action: 'enable-bedrock',
      inferenceRegion: 'eu-central-1',
      grantModel: ['amazon-bedrock/profile'],
      allowRestart: true,
      acceptPluginCapabilities: true,
      yes: true,
    });
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), plan);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(bedrockJob.plugin.integrity),
    );
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        models: ['amazon-bedrock/profile'],
        allowRestart: true,
        acceptPluginCapabilities: true,
      }),
    );
  });
  it('discards an unapproved preview and refuses missing explicit plugin/restart consent', async () => {
    await expect(
      runProvidersCommand({ action: 'enable-bedrock', inferenceRegion: 'eu-central-1' }),
    ).rejects.toThrow(/--yes/);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.prepare.mockResolvedValue({
      ...plan,
      job: { ...bedrockJob, acceptPluginCapabilities: false },
    });
    await expect(
      runProvidersCommand({ action: 'enable-bedrock', inferenceRegion: 'eu-central-1', yes: true }),
    ).rejects.toThrow(/--accept-plugin-capabilities/);
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });
  it('inspects without reapplying and requires explicit configured/previous reconciliation choice', async () => {
    await runProvidersCommand({ action: 'inspect', operationId: bedrockJob.operationId });
    expect(mocks.apply).not.toHaveBeenCalled();
    await expect(
      runProvidersCommand({ action: 'reconcile', operationId: bedrockJob.operationId }),
    ).rejects.toThrow(/Choose/);
    await runProvidersCommand({
      action: 'reconcile',
      operationId: bedrockJob.operationId,
      accept: 'previous',
      yes: true,
    });
    expect(mocks.inspect).toHaveBeenLastCalledWith(expect.anything(), bedrockJob.operationId, {
      accept: 'previous',
    });
  });
  it('requires explicit abort approval and uses the recorded operation without repeating setup', async () => {
    await expect(
      runProvidersCommand({ action: 'abort', operationId: bedrockJob.operationId }),
    ).rejects.toThrow(/--yes/);
    await runProvidersCommand({ action: 'abort', operationId: bedrockJob.operationId, yes: true });
    expect(mocks.inspect).toHaveBeenLastCalledWith(expect.anything(), bedrockJob.operationId, {
      abort: true,
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Retain plugin/role files and IAM grants'),
    );
    await expect(
      runProvidersCommand({
        action: 'abort',
        operationId: bedrockJob.operationId,
        accept: 'previous',
        yes: true,
      }),
    ).rejects.toThrow(/--accept/);
  });
});
