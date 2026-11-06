import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { object, parseMembers, type BackupMember } from './backup-contract.js';
type ConfigSdk = typeof import('openclaw/plugin-sdk/config-mutation');
type NativeConfig = NonNullable<Parameters<ConfigSdk['replaceConfigFile']>[0]['sourceConfig']>;

/** Public, non-inference checks usable after setup, on lost-reply adoption and
 * during deliberate activation. No source native state is loaded.
 */
export async function verifyNativeClone(options: {
  members: BackupMember[];
  nativePackageJson: string;
  configurationHash?: string;
  signal?: AbortSignal;
  validateConfig?: (config: NativeConfig) => void;
}) {
  const home = homedir();
  const state = path.join(home, '.openclaw');
  const configPath = path.join(state, 'openclaw.json');
  const require = createRequire(options.nativePackageJson);
  const sdk = (await import(
    pathToFileURL(require.resolve('openclaw/plugin-sdk/config-mutation')).href
  )) as typeof import('openclaw/plugin-sdk/config-mutation');
  const before = await sdk.readConfigFileSnapshotForWrite({ observe: false });
  const hash = before.snapshot.hash;
  if (
    !before.snapshot.valid ||
    !before.snapshot.sourceConfig ||
    before.snapshot.path !== configPath ||
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    (options.configurationHash !== undefined && options.configurationHash !== hash)
  )
    throw new Error('Native clone configuration differs from its certified setup');
  options.validateConfig?.(before.snapshot.sourceConfig!);
  const env = {
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_HIDE_BANNER: '1',
    NO_COLOR: '1',
    OPENCLAW_DEFER_SHELL_ENV_FALLBACK: '1',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true',
  };
  const native = async (args: string[]) => {
    try {
      const result = await execa(
        process.execPath,
        [path.join(path.dirname(options.nativePackageJson), 'openclaw.mjs'), ...args, '--json'],
        {
          env,
          extendEnv: false,
          timeout: 180000,
          cancelSignal: options.signal,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error(
        'Native clone validation failed; private authentication output was not published',
      );
    }
  };
  await native(['config', 'validate']);
  const members = parseMembers(await native(['agents', 'list']));
  if (
    members.length !== options.members.length ||
    options.members.some((expected) => {
      const actual = members.find((member) => member.id === expected.id);
      return (
        !actual ||
        actual.workspace !== expected.workspace ||
        actual.agentDir !== expected.agentDir ||
        (expected.model !== undefined && actual.model !== expected.model)
      );
    })
  )
    throw new Error(
      'Native clone roster or model selection differs from the reviewed content plan',
    );
  const audit = object(await native(['secrets', 'audit']));
  if (
    object(audit.resolution).resolvabilityComplete !== true ||
    object(audit.summary).unresolvedRefCount !== 0
  )
    throw new Error('Fresh native clone credentials are not fully resolvable');
  for (const member of members) await native(['models', 'status', '--agent', member.id, '--check']);
  const after = await sdk.readConfigFileSnapshotForWrite({ observe: false });
  if (!after.snapshot.valid || after.snapshot.hash !== hash)
    throw new Error('Native clone configuration changed during validation');
  return { members, configurationHash: hash };
}
