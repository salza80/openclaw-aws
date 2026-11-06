import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';
import { bedrockRoleProfile } from './bedrock-profile.js';
import type { ModelMutationRecord, NativeModelClient } from './model-control.js';

const methods = new Set([
  'config.get',
  'config.patch',
  'agents.list',
  'models.list',
  'sessions.list',
  'health',
  'plugins.list',
  'plugins.inspect',
  'plugins.install',
  'plugins.setEnabled',
  'gateway.suspend.prepare',
  'gateway.suspend.status',
  'gateway.suspend.resume',
]);
/** Public native capability gate, parsed without retaining arbitrary errors or
 * native output. Only the fixed reviewed install may acknowledge this token. */
export class NativeCapabilityConsentRequired extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly reviewToken: string,
  ) {
    super('Native plugin capability consent is required');
  }
}
function capabilityConsent(value: unknown): NativeCapabilityConsentRequired | undefined {
  if (!value || typeof value !== 'object') return;
  const details = (value as { error?: { details?: Record<string, unknown> } }).error?.details;
  if (details?.capabilityConsentCode !== 'PLUGIN_CAPABILITY_CONSENT_REQUIRED') return;
  if (details.persistence !== undefined) return;
  if (
    typeof details.pluginId !== 'string' ||
    !/^[a-z0-9-]{1,128}$/.test(details.pluginId) ||
    typeof details.reviewToken !== 'string' ||
    !details.reviewToken ||
    details.reviewToken.length > 8192 ||
    [...details.reviewToken].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return;
  return new NativeCapabilityConsentRequired(details.pluginId, details.reviewToken);
}
export function modelClientEnvironment(options: {
  home: string;
  gatewayToken: string;
  port?: number;
  bedrockDeploymentRegion?: string;
}) {
  const port = options.port ?? 18789;
  if (
    !path.isAbsolute(options.home) ||
    options.home === '/' ||
    path.resolve(options.home) !== options.home ||
    !options.gatewayToken ||
    options.gatewayToken.length > 4096 ||
    [...options.home, ...options.gatewayToken].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Native model client requires a private home, valid token and local port');
  return {
    HOME: options.home,
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    OPENCLAW_STATE_DIR: path.join(options.home, '.openclaw'),
    OPENCLAW_CONFIG_PATH: path.join(options.home, '.openclaw/openclaw.json'),
    OPENCLAW_GATEWAY_TOKEN: options.gatewayToken,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_DEFER_SHELL_ENV_FALLBACK: '1',
    OPENCLAW_HIDE_BANNER: '1',
    XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
    NO_COLOR: '1',
    ...(options.bedrockDeploymentRegion
      ? bedrockRoleProfile(options.home, options.bedrockDeploymentRegion).environment
      : {
          AWS_CONFIG_FILE: '/dev/null',
          AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
          AWS_EC2_METADATA_DISABLED: 'true',
        }),
  };
}

/** Public native CLI/RPC only. Pin loopback and explicit token input so saved
 * remote-Gateway settings, shell profiles and operator credentials cannot retarget
 * an AWS-hosted model operation. Child output/errors stay inside the worker.
 */
export function createNativeModelClient(options: {
  home: string;
  packageJson: string;
  gatewayToken: string;
  port?: number;
  bedrockDeploymentRegion?: string;
  signal?: AbortSignal;
  record(value: ModelMutationRecord): Promise<void>;
  /** An embedding host can supply its own controlled native service lifecycle. */
  restart?: () => Promise<void>;
}): NativeModelClient {
  const env = modelClientEnvironment(options);
  const native = path.join(path.dirname(options.packageJson), 'openclaw.mjs');
  if (!path.isAbsolute(options.packageJson))
    throw new Error('Native package must have an absolute verified location');
  const run = async (
    args: string[],
    timeout: number,
    signal = options.signal,
  ): Promise<unknown> => {
    try {
      const result = await execa(process.execPath, [native, ...args], {
        env,
        extendEnv: false,
        cwd: options.home,
        cancelSignal: signal,
        timeout,
        forceKillAfterDelay: 5000,
        maxBuffer: 16 * 1024 * 1024,
        reject: false,
      });
      const value: unknown = JSON.parse(result.stdout);
      if (result.exitCode !== 0 || result.failed || result.isCanceled || result.timedOut) {
        const consent =
          !result.isCanceled && !result.timedOut ? capabilityConsent(value) : undefined;
        if (consent) throw consent;
        throw new Error('Native model command did not complete');
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        ('ok' in value && value.ok === false && 'error' in value)
      )
        throw new Error('Native model command returned an invalid response');
      return value;
    } catch (error) {
      if (error instanceof NativeCapabilityConsentRequired) throw error;
      // Execa errors may embed native config/auth output. Never attach them as
      // public causes or print the command environment during reconciliation.
      // eslint-disable-next-line preserve-caught-error -- Child errors may include credentials and private native output.
      throw new Error(
        'Native Gateway model request failed or was interrupted; private output was not published',
      );
    }
  };
  const call = async (
    method: string,
    params: Record<string, unknown>,
    timeout = method === 'plugins.install' ? 240000 : 60000,
    signal = options.signal,
  ) => {
    if (!methods.has(method)) throw new Error('Unsupported native model control method');
    const serialized = JSON.stringify(params);
    if (Buffer.byteLength(serialized) > 64 * 1024)
      throw new Error('Native model request exceeds the bounded control payload');
    return run(
      [
        'gateway',
        'call',
        method,
        '--port',
        String(options.port ?? 18789),
        '--expect-url',
        `ws://127.0.0.1:${options.port ?? 18789}`,
        '--params',
        serialized,
        '--timeout',
        String(timeout),
        '--json',
      ],
      timeout + 5000,
      signal,
    );
  };
  return {
    call,
    record: options.record,
    async health() {
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000);
      while (true) {
        signal.throwIfAborted();
        try {
          const value = await call('health', {}, 5000, signal);
          if (value && typeof value === 'object' && 'ok' in value && value.ok === true) return;
        } catch {
          /* A deliberately restarting Gateway can be temporarily absent. */
        }
        await delay(1000, undefined, { signal });
      }
    },
    async restart() {
      if (options.restart) return options.restart();
      await run(['gateway', 'restart', '--json'], 180000);
    },
  };
}
