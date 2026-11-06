import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execa: vi.fn() }));
vi.mock('execa', () => ({ execa: mocks.execa }));
import {
  createNativeModelClient,
  modelClientEnvironment,
} from '../../src/openclaw/model-client.js';
const options = {
  home: '/home/ubuntu',
  packageJson: '/home/ubuntu/.openclaw/tools/node/lib/node_modules/openclaw/package.json',
  gatewayToken: 'fixture-private-gateway-token',
  record: async () => {},
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.execa.mockResolvedValue({ exitCode: 0, failed: false, stdout: '{"ok":true}' });
});
describe('private native model client', () => {
  it('uses only the selected local Gateway, private token environment and home working directory', async () => {
    const client = createNativeModelClient(options);
    await client.call('config.get', {});
    const [executable, args, run] = mocks.execa.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(args).toContain('ws://127.0.0.1:18789');
    expect(args).toContain('--port');
    expect(args).toContain('--expect-url');
    expect(args).not.toContain('--url');
    expect(JSON.stringify(args)).not.toContain(options.gatewayToken);
    expect(run).toMatchObject({
      cwd: options.home,
      extendEnv: false,
      env: {
        HOME: options.home,
        OPENCLAW_GATEWAY_TOKEN: options.gatewayToken,
        AWS_CONFIG_FILE: '/dev/null',
      },
    });
    expect(run.env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(run.env).not.toHaveProperty('AWS_PROFILE');
  });
  it('enables only the isolated region profile when the host explicitly configured Bedrock role auth', () => {
    const env = modelClientEnvironment({ ...options, bedrockDeploymentRegion: 'eu-central-1' });
    expect(env).toMatchObject({
      AWS_PROFILE: 'openclaw-instance-role',
      AWS_CONFIG_FILE: '/home/ubuntu/.openclaw-aws/aws/config',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    });
    expect(env).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
  it('refuses inference/arbitrary methods and oversized payloads before spawning native commands', async () => {
    const client = createNativeModelClient(options);
    await expect(client.call('agent', { message: 'must not send' })).rejects.toThrow(/Unsupported/);
    await expect(client.call('config.patch', { raw: 'x'.repeat(65537) })).rejects.toThrow(
      /bounded/,
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });
  it('does not expose child output, credentials or captured execa errors on failure', async () => {
    mocks.execa.mockRejectedValue(Error(`private provider and token: ${options.gatewayToken}`));
    try {
      await createNativeModelClient(options).call('config.get', {});
      throw Error('expected failure');
    } catch (error) {
      expect(String(error)).toContain('private output was not published');
      expect(String(error)).not.toContain(options.gatewayToken);
      expect(error).not.toHaveProperty('cause');
    }
    mocks.execa.mockResolvedValue({
      exitCode: 1,
      failed: true,
      stdout: `private native output: ${options.gatewayToken}`,
    });
    await expect(createNativeModelClient(options).call('config.get', {})).rejects.toThrow(
      /private output was not published/,
    );
  });
  it('checks authenticated native health and invokes the local native service lifecycle only on explicit restart', async () => {
    const client = createNativeModelClient(options);
    await client.health();
    expect(mocks.execa.mock.calls[0][1]).toContain('health');
    await client.restart();
    expect(mocks.execa.mock.calls[1][1].slice(1)).toEqual(['gateway', 'restart', '--json']);
  });
  it('honors cancellation before readiness checks', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createNativeModelClient({ ...options, signal: controller.signal }).health(),
    ).rejects.toThrow();
    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
