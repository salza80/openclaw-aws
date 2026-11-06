import { execa } from 'execa';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { assertDirectoryChain } from './restore-layout.js';
import { privateModelText } from './model-journal.js';
import { createInstanceControlHost } from './native-control-host.js';
import { createNativeModelClient, modelClientEnvironment } from './model-client.js';
import {
  assertBedrockRoleInputs,
  bedrockRoleProfile,
  prepareBedrockRoleProfile,
} from './bedrock-profile.js';
import { bedrockConfigurationPatch, configureNativeBedrock } from './bedrock-configuration.js';
import {
  bedrockNativeSnapshot,
  bedrockUnrelatedConfigHash,
  inspectNativeBedrockPlugin,
  ensureNativeBedrockPlugin,
  nativeBedrockConfigured,
  refreshNativeBedrockDiscovery,
} from './bedrock-native.js';
import { parseBedrockJob, type BedrockWorkerMode } from './bedrock-contract.js';
import { runBedrockOperation, type BedrockWorkerHost } from './bedrock-worker.js';

/** systemctl's quoted Environment property is data, never shell input. Values
 * stay private; diagnostics identify conflicts by variable name only. */
export function parseServiceEnvironment(text: string): Record<string, string> {
  if (text.length > 128 * 1024 || /[\0\r\n]/.test(text))
    throw new Error('Unsupported native service environment');
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') escaped = true;
    else if (quote) {
      if (character === quote) quote = '';
      else token += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else token += character;
  }
  if (quote || escaped) throw new Error('Unsupported native service environment quoting');
  if (token) tokens.push(token);
  const result: Record<string, string> = {};
  for (const value of tokens) {
    const index = value.indexOf('=');
    const key = value.slice(0, index);
    if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(result, key))
      throw new Error('Ambiguous native service environment');
    Object.defineProperty(result, key, {
      value: value.slice(index + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function checkFixedFile(home: string, filename: string, expected: string, required: boolean) {
  try {
    await assertDirectoryChain(path.dirname(filename), home, false);
    if ((await privateModelText(filename)) !== expected)
      throw new Error(
        'Managed Bedrock role file has different contents; automatic overwrite refused',
      );
  } catch (error) {
    if (!required && missing(error)) return;
    throw error;
  }
}
/** Real AWS/Ubuntu boundary for the shared durable provider worker. The entry
 * point owns flock; no static credentials or operator profile reach this host. */
export async function runAwsBedrockWorker(
  input: unknown,
  mode: BedrockWorkerMode,
  signal?: AbortSignal,
) {
  const job = parseBedrockJob(input);
  const control = await createInstanceControlHost(job, signal);
  let gatewayToken: string | undefined;
  const makeClient = (managed: boolean) => {
    if (!gatewayToken)
      throw new Error('Bedrock host identity must be verified before native access');
    return createNativeModelClient({
      home: control.home,
      packageJson: control.packageJson,
      gatewayToken,
      signal,
      record: async () => {},
      ...(managed ? { bedrockDeploymentRegion: job.target.region } : {}),
      restart: async () => {
        await systemctl(['daemon-reload']);
        const native = path.join(path.dirname(control.packageJson), 'openclaw.mjs');
        try {
          await execa(process.execPath, [native, 'gateway', 'restart', '--json'], {
            env: modelClientEnvironment({
              home: control.home,
              gatewayToken: gatewayToken!,
              bedrockDeploymentRegion: job.target.region,
            }),
            extendEnv: false,
            cwd: control.home,
            cancelSignal: signal,
            timeout: 180000,
            maxBuffer: 1024 * 1024,
          });
        } catch {
          throw new Error('Native controlled restart failed; private output was not published');
        }
      },
    });
  };
  const systemctl = async (args: string[]) => {
    try {
      const result = await execa('/usr/bin/systemctl', ['--user', ...args], {
        env: {
          HOME: control.home,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
        },
        extendEnv: false,
        cancelSignal: signal,
        timeout: 30000,
        maxBuffer: 128 * 1024,
      });
      return result.stdout;
    } catch {
      throw new Error(
        'Native service inspection/reload failed; private environment output was not published',
      );
    }
  };
  const settings = {
    home: control.home,
    deploymentRegion: job.target.region,
    inferenceRegion: job.inferenceRegion,
  };
  const roleInputs = async (required: boolean) => {
    await assertDirectoryChain(path.join(control.home, '.openclaw'), control.home, false);
    const environment = parseDotenv(
      await privateModelText(path.join(control.home, '.openclaw/.env')),
    );
    assertBedrockRoleInputs(control.home, job.target.region, environment);
    const load = await systemctl([
      'show',
      'openclaw-gateway.service',
      '--property=LoadState',
      '--value',
    ]);
    if (load !== 'loaded')
      throw new Error('Bedrock enablement requires the existing installed native Gateway service');
    const files = await systemctl([
      'show',
      'openclaw-gateway.service',
      '--property=EnvironmentFiles',
      '--value',
    ]);
    if (
      files &&
      !new RegExp(
        `^${control.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.openclaw/\\.env \\(ignore_errors=(?:yes|no)\\)$`,
      ).test(files)
    )
      throw new Error(
        'Native service has additional environment files; review them privately before enabling managed role authentication',
      );
    const live = parseServiceEnvironment(
      await systemctl(['show', 'openclaw-gateway.service', '--property=Environment', '--value']),
    );
    assertBedrockRoleInputs(control.home, job.target.region, live);
    const plan = bedrockRoleProfile(control.home, job.target.region);
    await checkFixedFile(control.home, plan.filename, plan.contents, required);
    await checkFixedFile(control.home, plan.serviceFilename, plan.serviceContents, required);
    if (required && Object.entries(plan.environment).some(([key, value]) => live[key] !== value))
      throw new Error('Native service has not loaded the managed role environment');
  };
  const host: BedrockWorkerHost = {
    home: control.home,
    async identify() {
      gatewayToken = await control.identify();
    },
    async preflight() {
      const client = makeClient(false);
      const snapshot = await bedrockNativeSnapshot(client);
      bedrockConfigurationPatch({ ...settings, config: snapshot.config });
      await roleInputs(false);
      const plugin = await inspectNativeBedrockPlugin(client);
      await client.health();
      const confirmed = await bedrockNativeSnapshot(client);
      if (confirmed.hash !== snapshot.hash)
        throw new Error('Native configuration changed during provider preview');
      return {
        configHash: snapshot.hash,
        unrelatedHash: bedrockUnrelatedConfigHash(snapshot.config),
        pluginInstalled: plugin.installed,
      };
    },
    async revision() {
      const snapshot = await bedrockNativeSnapshot(makeClient(false));
      return {
        configHash: snapshot.hash,
        unrelatedHash: bedrockUnrelatedConfigHash(snapshot.config),
      };
    },
    async installPlugin() {
      await ensureNativeBedrockPlugin(makeClient(false), job.acceptPluginCapabilities);
    },
    async prepareEnvironment() {
      await roleInputs(false);
      await prepareBedrockRoleProfile(control.home, job.target.region, {
        serviceEnvironment: true,
      });
      await systemctl(['daemon-reload']);
    },
    async configure(_job, expectedHash, record, verify) {
      return configureNativeBedrock(makeClient(true), {
        ...settings,
        expectedHash,
        allowRestart: job.allowRestart,
        record,
        verify,
      });
    },
    async refresh() {
      return refreshNativeBedrockDiscovery(makeClient(true), { signal });
    },
    async observe() {
      const client = makeClient(true);
      await client.health();
      const before = await bedrockNativeSnapshot(client);
      await roleInputs(true);
      const plugin = await inspectNativeBedrockPlugin(client);
      const after = await bedrockNativeSnapshot(client);
      if (after.hash !== before.hash)
        throw new Error('Native configuration changed during Bedrock observation');
      return {
        configHash: after.hash,
        configured: nativeBedrockConfigured(after.config, settings),
        pluginVerified: plugin.installed && plugin.enabled,
        roleEnvironmentVerified: true,
        checkedAt: new Date().toISOString(),
      };
    },
  };
  try {
    return await runBedrockOperation(job, host, mode);
  } finally {
    control.dispose();
  }
}
