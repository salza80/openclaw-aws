import { describe, expect, it } from 'vitest';
import { parse as parseDotenv } from 'dotenv';
import {
  restoredEnvironmentText,
  restoredInactiveConfig,
} from '../../src/openclaw/restore-reconciliation.js';
describe('inactive native restore configuration', () => {
  const gatewayToken = 'a'.repeat(48);
  const options = {
    gatewayToken,
    oldPluginDirectory: '/old/managed-plugin',
    pluginDirectory: '/new/managed-plugin',
  };
  it('preserves every member, model and permission while pausing automatic integrations and rotating Gateway auth', () => {
    const original = {
      gateway: {
        mode: 'remote' as const,
        remote: { url: 'ws://old', token: 'old' },
        auth: { mode: 'password' as const, password: 'old' },
      },
      agents: {
        ownership: 'explicit' as const,
        defaults: { model: { primary: 'openrouter/example' } },
        entries: {
          main: { workspace: '/home/ubuntu/main' },
          researcher: {
            model: 'anthropic/example',
            workspace: '/home/ubuntu/research',
            agentDir: '/home/ubuntu/member',
          },
        },
      },
      cron: { enabled: true, triggers: { enabled: true } },
      hooks: { enabled: true, internal: { enabled: true } },
      channels: {
        telegram: { enabled: true, accounts: { work: { enabled: true, botToken: 'secret' } } },
      },
      plugins: { load: { paths: ['/old/managed-plugin', '/user/plugin'] } },
      env: { vars: { OPENCLAW_GATEWAY_TOKEN: 'old', OPENROUTER_API_KEY: 'model-key' } },
    };
    const result = restoredInactiveConfig(original, options);
    expect(result.agents).toEqual(original.agents);
    expect(result.gateway).toEqual({
      mode: 'local',
      bind: 'loopback',
      port: 18789,
      auth: { mode: 'token', token: gatewayToken, allowTailscale: false },
      tailscale: { mode: 'off' },
    });
    expect(result.cron).toMatchObject({
      enabled: false,
      skipMissedJobs: true,
      triggers: { enabled: false },
    });
    expect(result.hooks).toMatchObject({ enabled: false, internal: { enabled: false } });
    expect(result.channels?.telegram).toMatchObject({
      enabled: false,
      accounts: { work: { enabled: false, botToken: 'secret' } },
    });
    expect(result.plugins?.load?.paths).toEqual(['/new/managed-plugin', '/user/plugin']);
    expect(result.env?.vars).toEqual({
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENROUTER_API_KEY: 'model-key',
    });
    expect(original.cron.enabled).toBe(true);
    expect(original.gateway.auth.password).toBe('old');
  });
  it('writes environment values losslessly instead of changing backslashes or embedded quotes', () => {
    const environment = {
      SIMPLE: 'key',
      MULTILINE: 'a\nb',
      LITERAL: 'a\\nb',
      QUOTES: 'a"b\'c`d',
      PATH: 'C:\\stuff\\new',
      COMMENTS: 'a # b',
      EMPTY: '',
    };
    expect(parseDotenv(restoredEnvironmentText(environment))).toEqual(environment);
    expect(() => restoredEnvironmentText({ 'invalid-name': 'secret' })).toThrow('variable names');
  });
  it('rejects an invalid fresh credential before changing native data', () => {
    expect(() => restoredInactiveConfig({}, { ...options, gatewayToken: 'old' })).toThrow(
      'credential',
    );
  });
});
