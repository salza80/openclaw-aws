import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execa } from 'execa';
import { parse as parseDotenv } from 'dotenv';
import { nativeStorageReadConfig } from './storage-config.js';
import { savedBedrockRecoveryIntent } from './bedrock-recovery-intent.js';
import { recoverySessionModels } from './recovery-session-models.js';
import { restoredPluginInstalls } from './restore-plugins.js';
import { assertRecoveryBedrockNative } from './recovery-bedrock-native.js';
import { bedrockRoleProfile } from './bedrock-profile.js';
import { OPENCLAW_NODE_VERSION, OPENCLAW_VERSION } from '../cli/constants.js';
import {
  object,
  parseCapture,
  parseMembers,
  parseVerification,
  textField,
  type BackupCaptureJob,
  type NativeCaptureSummary,
  type BackupMember,
} from './backup-contract.js';

type ConfigSdk = typeof import('openclaw/plugin-sdk/config-mutation');
export interface GatewayControl {
  inspect(): Promise<'active' | 'inactive' | 'failed'>;
  stop(): Promise<void>;
  start(): Promise<void>;
}
const within = (root: string, candidate: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
async function privateNative(
  args: string[],
  entrypoint: string,
  env: Record<string, string | undefined> = process.env,
  timeout = 120000,
  signal?: AbortSignal,
) {
  try {
    return await execa(process.execPath, [entrypoint, ...args], {
      env,
      extendEnv: false,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      cancelSignal: signal,
    });
  } catch {
    throw new Error('Native OpenClaw command failed; no private command output was published');
  }
}
const defaultGateway: GatewayControl = {
  async inspect() {
    const result = await execa(
      'systemctl',
      ['--user', 'show', 'openclaw-gateway.service', '--property=ActiveState', '--value'],
      { timeout: 15000 },
    );
    if (!['active', 'inactive', 'failed'].includes(result.stdout))
      throw new Error('Gateway service is transitioning or unavailable');
    return result.stdout as 'active' | 'inactive' | 'failed';
  },
  async stop() {
    await execa('systemctl', ['--user', 'stop', 'openclaw-gateway.service'], { timeout: 60000 });
  },
  async start() {
    await execa('systemctl', ['--user', 'start', 'openclaw-gateway.service'], { timeout: 60000 });
  },
};

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

/** Pinned public native APIs and commands; no private hashed module imports. */
export async function nativeBackupHost(
  job: BackupCaptureJob,
  options: { nativePackageJson?: string; gateway?: GatewayControl; signal?: AbortSignal } = {},
) {
  if (process.version !== `v${OPENCLAW_NODE_VERSION}`)
    throw new Error('Backup worker requires the supported Node runtime');
  const packageJson =
    options.nativePackageJson ??
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/openclaw/package.json');
  if (JSON.parse(await readFile(packageJson, 'utf8')).version !== OPENCLAW_VERSION)
    throw new Error('Backup worker requires the supported OpenClaw version');
  const require = createRequire(packageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/config-mutation')).href
  )) as ConfigSdk;
  const entrypoint = path.join(path.dirname(packageJson), 'openclaw.mjs');
  const gateway = options.gateway ?? defaultGateway;
  const environment: Record<string, string | undefined> = {
    ...process.env,
    AWS_REGION: job.source.region,
    AWS_DEFAULT_REGION: job.source.region,
    OPENCLAW_AWS_BACKUP_OPERATION_ID: job.operationId,
  };
  const locationName = `aws-vault-${createHash('sha256')
    .update(
      JSON.stringify([
        job.settings.bucket,
        job.settings.region,
        job.settings.prefix,
        job.settings.expectedBucketOwner,
      ]),
    )
    .digest('hex')
    .slice(0, 24)}`;
  const storeName = `OPENCLAW_AWS_VAULT_${job.key.versionStage.slice(-32).toUpperCase()}_PASSPHRASE`;
  const runJson = async (args: string[], env = environment, timeout?: number): Promise<unknown> =>
    JSON.parse(
      (await privateNative([...args, '--json'], entrypoint, env, timeout, options.signal)).stdout,
    );
  let scratch: string | undefined;
  let passphrase: string | undefined;
  return {
    locationName,
    runtime: { openclaw: OPENCLAW_VERSION, node: OPENCLAW_NODE_VERSION },
    gateway: {
      async inspect() {
        if (!options.gateway) {
          const unit = (
            await execa(
              'systemctl',
              [
                '--user',
                'show',
                'openclaw-gateway.service',
                '--property=Environment',
                '--property=ExecStart',
                '--value',
              ],
              { timeout: 15000 },
            )
          ).stdout;
          if (/--profile(?:[=\s])|--dev(?:[\s;}])/.test(unit))
            throw new Error(
              'Non-default native service profiles require a separately supported recovery mapping',
            );
          const expected: Record<string, string> = {
            OPENCLAW_STATE_DIR: path.join(homedir(), '.openclaw'),
            OPENCLAW_CONFIG_PATH: path.join(homedir(), '.openclaw/openclaw.json'),
            OPENCLAW_HOME: homedir(),
          };
          for (const [name, value] of Object.entries(expected)) {
            const match = new RegExp(`(?:^|\\s)"?${name}=([^\\s"]+)`).exec(unit);
            if (match && match[1] !== value)
              throw new Error(
                'Gateway uses non-default native state paths; backup refused before capture',
              );
          }
        }
        return gateway.inspect();
      },
      stop: () => gateway.stop(),
      async start() {
        await gateway.start();
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          try {
            if (
              object(
                JSON.parse(
                  (
                    await privateNative(
                      ['health', '--json'],
                      entrypoint,
                      environment,
                      Math.max(1, Math.min(10000, deadline - Date.now())),
                    )
                  ).stdout,
                ),
              ).ok === true
            )
              return;
          } catch {
            /* Readiness can follow systemd activation. */
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error('Gateway restart did not establish authenticated native health');
      },
    },
    async prepareStorage(material: string) {
      const initial = await sdk.readConfigFileSnapshotForWrite();
      if (!initial.snapshot.exists || !initial.snapshot.valid)
        throw new Error('Native source configuration is missing or invalid');
      passphrase = material;
      scratch = await mkdtemp(path.join(tmpdir(), 'openclaw-capture-'));
      const input = path.join(scratch, 'key-input');
      try {
        await writeFile(input, material, { mode: 0o600 });
        await privateNative(
          ['secrets', 'store', 'set', storeName, '--kind', 'secret', '--value-file', input],
          entrypoint,
          environment,
          120000,
          options.signal,
        );
      } finally {
        await rm(input, { force: true });
      }
      const before = await sdk.readConfigFileSnapshotForWrite();
      if (!before.snapshot.exists || !before.snapshot.valid || !before.snapshot.hash)
        throw new Error('Native source configuration is missing or invalid');
      const changed = await sdk.mutateConfigFile({
        base: 'source',
        baseHash: before.snapshot.hash,
        afterWrite: { mode: 'none', reason: 'Gateway is quiesced for a verified backup' },
        async mutate(draft) {
          draft.plugins ??= {};
          if (draft.plugins.enabled === false)
            throw new Error('Native plugins are disabled; backup storage cannot be activated');
          draft.plugins.load ??= {};
          const managedRoot = path.dirname(job.pluginDirectory);
          const preserved: string[] = [];
          for (const value of draft.plugins.load.paths ?? []) {
            if (value === job.pluginDirectory) continue;
            if (
              path.dirname(value) === managedRoot &&
              /^[a-f0-9]{64}$/.test(path.basename(value))
            ) {
              const prior = object(
                JSON.parse(await readFile(path.join(value, 'openclaw.plugin.json'), 'utf8')),
              );
              if (prior.id === 'openclaw-aws-s3') continue;
            }
            preserved.push(value);
          }
          draft.plugins.load.paths = [...preserved, job.pluginDirectory];
          if (draft.plugins.allow && !draft.plugins.allow.includes('openclaw-aws-s3'))
            draft.plugins.allow.push('openclaw-aws-s3');
          draft.plugins.entries ??= {};
          draft.plugins.entries['openclaw-aws-s3'] = {
            ...draft.plugins.entries['openclaw-aws-s3'],
            enabled: true,
          };
          draft.secrets ??= {};
          draft.secrets.providers ??= {};
          if (
            draft.secrets.providers['aws-backup-store'] &&
            draft.secrets.providers['aws-backup-store'].source !== 'store'
          )
            throw new Error('Native backup secret-provider name is already in use');
          draft.secrets.providers['aws-backup-store'] = { source: 'store' };
          draft.storage ??= { locations: {} };
          draft.storage.locations ??= {};
          const previous = draft.storage.locations[locationName];
          if (
            previous &&
            (previous.provider !== 'aws-s3' || !isDeepStrictEqual(previous.settings, job.settings))
          )
            throw new Error('Native backup location identity changed');
          draft.storage.locations[locationName] = {
            provider: 'aws-s3',
            settings: job.settings,
            encryption: {
              passphrase: { source: 'store', provider: 'aws-backup-store', id: storeName },
            },
          };
        },
      });
      try {
        const plugins = object(await runJson(['plugins', 'list']));
        if (!Array.isArray(plugins.plugins))
          throw new Error('Native plugin inventory is unavailable');
        const provider = plugins.plugins.map(object).find((item) => item.id === 'openclaw-aws-s3');
        if (
          provider?.status !== 'loaded' ||
          (await realpath(textField(provider.rootDir))) !== (await realpath(job.pluginDirectory))
        )
          throw new Error('Native S3 plugin did not load from the verified artifact');
        await runJson(['config', 'validate']);
      } catch {
        if (!changed.persistedHash)
          throw new Error('Backup configuration failed and has no safe rollback hash');
        await sdk.replaceConfigFile({
          sourceConfig: before.snapshot.sourceConfig,
          baseHash: changed.persistedHash,
          afterWrite: { mode: 'none', reason: 'Failed backup storage configuration rollback' },
        });
        throw new Error('Backup configuration validation failed; prior configuration was restored');
      }
      const init = object(await runJson(['storage', 'init', locationName]));
      if (init.state !== 'ok' || init.encrypted !== true || typeof init.locationId !== 'string')
        throw new Error('Native encrypted storage initialization failed');
      if (object(await runJson(['storage', 'test', locationName])).state !== 'ok')
        throw new Error('Native storage write/read/delete test failed');
      return { locationId: init.locationId };
    },
    async members() {
      return Promise.all(
        parseMembers(await runJson(['agents', 'list'])).map(async (member) => ({
          ...member,
          agentDir: await canonicalPath(member.agentDir),
          workspace: await canonicalPath(member.workspace),
        })),
      );
    },
    async capture() {
      return parseCapture(
        await runJson(
          ['backup', 'create', '--to', locationName, '--namespace', job.namespace],
          environment,
          20 * 60 * 1000,
        ),
      );
    },
    async credentials(capture: NativeCaptureSummary, members: BackupMember[] = []) {
      const snapshot = await sdk.readConfigFileSnapshotForWrite();
      if (!snapshot.snapshot.valid)
        throw new Error('Native configuration became invalid during capture');
      const configurationPath = await canonicalPath(snapshot.snapshot.path);
      if (!capture.assets.some((asset) => within(asset.sourcePath, configurationPath)))
        throw new Error('Native backup omitted the source configuration');
      const state = capture.assets.find((asset) => asset.kind === 'state');
      if (!state) throw new Error('Native capture has no state asset');
      let sourceEnv: Record<string, string> = {};
      try {
        sourceEnv = parseDotenv(await readFile(path.join(state.sourcePath, '.env')));
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
          throw error;
      }
      const bedrock = savedBedrockRecoveryIntent({
        config: snapshot.snapshot.sourceConfig,
        home: homedir(),
        deploymentRegion: job.source.region,
        environment: sourceEnv,
        members,
        sessionModels: await recoverySessionModels({
          nativePackageJson: packageJson,
          config: snapshot.snapshot.sourceConfig,
          members,
        }),
      });
      if (bedrock)
        await assertRecoveryBedrockNative({
          config: snapshot.snapshot.sourceConfig,
          environment: sourceEnv,
          home: homedir(),
          deploymentRegion: job.source.region,
          intent: bedrock,
        });
      const stored = await runJson(['secrets', 'store', 'list']);
      const entries = Array.isArray(stored) ? stored : object(stored).entries;
      const storedEnv = new Set(
        Array.isArray(entries)
          ? entries
              .map(object)
              .filter((entry) => entry.kind === 'env')
              .map((entry) => entry.name)
          : [],
      );
      const config = object(snapshot.snapshot.sourceConfig);
      const configEnv = config.env && typeof config.env === 'object' ? object(config.env) : {};
      const variables =
        configEnv.vars && typeof configEnv.vars === 'object' ? object(configEnv.vars) : {};
      const providers = snapshot.snapshot.sourceConfig.secrets?.providers ?? {};
      const requiredEnvironment = (name: string) => {
        if (
          !Object.hasOwn(sourceEnv, name) &&
          !Object.hasOwn(variables, name) &&
          !storedEnv.has(name)
        )
          throw new Error(
            'A required environment secret is outside captured native recovery state',
          );
      };
      const inspect = async (value: unknown): Promise<void> => {
        if (typeof value === 'string') {
          for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
            if (match[1] !== 'HOME') requiredEnvironment(match[1]);
          }
          return;
        }
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          await Promise.all(value.map(inspect));
          return;
        }
        const row = value as Record<string, unknown>;
        if (
          ['env', 'store', 'file', 'exec'].includes(String(row.source)) &&
          typeof row.provider === 'string' &&
          typeof row.id === 'string'
        ) {
          if (row.source === 'exec')
            throw new Error(
              'External executable secret references require independent recovery before full backup certification',
            );
          if (row.source === 'env') requiredEnvironment(row.id);
          if (row.source === 'file') {
            const provider = providers[row.provider];
            if (!provider || provider.source !== 'file')
              throw new Error('A required secret file is outside captured native recovery state');
            const resolvedPath = await canonicalPath(
              provider.path.startsWith('~/')
                ? path.join(homedir(), provider.path.slice(2))
                : path.resolve(provider.path),
            );
            const relative = path.relative(state.sourcePath, resolvedPath);
            if (
              ['tools', 'tmp', 'npm', 'npm-runtime', 'dev', 'git', 'plugin-skills'].includes(
                relative.split(path.sep)[0],
              )
            )
              throw new Error('A required secret file is inside an excluded runtime cache');
            if (!capture.assets.some((asset) => within(asset.sourcePath, resolvedPath))) {
              throw new Error('A required secret file resolves outside captured recovery state');
            }
          }
          return;
        }
        await Promise.all(Object.values(row).map(inspect));
      };
      await inspect(snapshot.snapshot.sourceConfig);
      // The native audit enumerates auth profiles and generated provider files as well
      // as the source config. Keep its raw findings and values inside this process.
      const audit = object(await runJson(['secrets', 'audit']));
      if (
        object(audit.resolution).resolvabilityComplete !== true ||
        object(audit.summary).unresolvedRefCount !== 0 ||
        !Array.isArray(audit.filesScanned)
      )
        throw new Error('Native credential inventory could not prove complete recovery coverage');
      if (bedrock) {
        const plugin = restoredPluginInstalls(await runJson(['plugins', 'registry'])).find(
          (entry) => entry.id === bedrock.plugin.id,
        );
        if (plugin?.spec !== bedrock.plugin.spec || plugin.integrity !== bedrock.plugin.integrity)
          throw new Error(
            'Saved Bedrock plugin provenance differs from the supported recovery artifact',
          );
      }
      for (const filename of audit.filesScanned) {
        const source = await canonicalPath(textField(filename));
        if (!capture.assets.some((asset) => within(asset.sourcePath, source))) {
          // This exact verified region-only file contains no credentials. It
          // is deliberately recreated on the target, never adopted as auth.
          if (bedrock && source === bedrockRoleProfile(homedir(), job.source.region).filename)
            continue;
          throw new Error('Native credential inventory includes a file outside captured state');
        }
        if (path.extname(source) === '.json')
          await inspect(JSON.parse(await readFile(source, 'utf8')));
      }
      return {
        mode: 'full-native' as const,
        configurationPath,
        sourceEnvironmentIncluded: Object.keys(sourceEnv).length > 0,
        prerequisites: [
          'Reinstall the pinned runtime and declared plugin dependencies; host OS caches and unowned external resources are not installation state.',
          ...(bedrock
            ? [
                'Recreate the target instance-role Bedrock profile/service environment and explicitly reviewed model permissions; AWS credentials and source IAM grants are not restored archive data.',
              ]
            : []),
        ],
        ...(bedrock ? { bedrock } : {}),
      };
    },
    async verify(key: string, versions: Record<string, string>) {
      if (!scratch || passphrase === undefined)
        throw new Error('Native backup verification context is unavailable');
      const directory = path.join(scratch, 'verify');
      await mkdir(directory, { mode: 0o700 });
      const keyInput = path.join(directory, 'key.json');
      const config = path.join(directory, 'openclaw.json');
      await writeFile(keyInput, JSON.stringify({ passphrase }), { mode: 0o600 });
      await writeFile(
        config,
        JSON.stringify(
          nativeStorageReadConfig(
            job.pluginDirectory,
            { ...job.settings, readVersions: versions },
            keyInput,
          ),
        ),
        { mode: 0o600 },
      );
      return parseVerification(
        await runJson(
          ['backup', 'verify', key, '--from', 'aws-vault', '--namespace', job.namespace],
          {
            ...environment,
            OPENCLAW_CONFIG_PATH: config,
            OPENCLAW_STATE_DIR: path.join(directory, 'state'),
          },
          20 * 60 * 1000,
        ),
      );
    },
    async close() {
      passphrase = undefined;
      if (scratch) await rm(scratch, { recursive: true, force: true });
    },
  };
}
export type NativeBackupHost = Awaited<ReturnType<typeof nativeBackupHost>>;
