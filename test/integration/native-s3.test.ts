import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { localS3 } from '../helpers/s3-server.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// A fresh managed-helper acceptance run can exercise the same conformance suite.
const installedHelper = process.env.OPENCLAW_AWS_TEST_NATIVE_HELPER;
const native = installedHelper
  ? path.join(installedHelper, 'node_modules/openclaw/openclaw.mjs')
  : path.join(root, 'node_modules/openclaw/openclaw.mjs');
const plugin = installedHelper
  ? path.join(installedHelper, 'plugin')
  : path.join(root, 'dist/native-plugins/aws-s3');
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const settings = {
  bucket: 'private-backups',
  prefix: 'vault/main',
  region: 'eu-central-1',
  expectedBucketOwner: '123456789012',
};
async function fresh() {
  const directory = await mkdtemp(path.join(tmpdir(), 'openclaw-native-backup-'));
  directories.push(directory);
  return directory;
}
function environment(directory: string, endpoint: string): Record<string, string> {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: directory,
    TMPDIR: directory,
    OPENCLAW_STATE_DIR: path.join(directory, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(directory, 'config.json'),
    OPENCLAW_AWS_VAULT_KEY: 'disposable-native-encryption-fixture',
    OPENCLAW_AWS_BACKUP_OPERATION_ID: 'native-fixture',
    AWS_CONFIG_FILE: path.join(directory, 'empty-aws-config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'empty-aws-credentials'),
    AWS_EC2_METADATA_SERVICE_ENDPOINT: endpoint,
    AWS_EC2_METADATA_V1_DISABLED: 'true',
    AWS_ENDPOINT_URL_S3: endpoint,
    AWS_REGION: 'eu-central-1',
    AWS_DEFAULT_REGION: 'eu-central-1',
    OPENCLAW_HIDE_BANNER: '1',
    NO_COLOR: '1',
  };
}
const pluginConfig = {
  allow: ['openclaw-aws-s3'],
  load: { paths: [plugin] },
  entries: { 'openclaw-aws-s3': { enabled: true } },
};
function storageConfig(extra = {}) {
  return {
    locations: {
      vault: {
        provider: 'aws-s3',
        settings: { ...settings, ...extra },
        encryption: {
          passphrase: { source: 'env', provider: 'default', id: 'OPENCLAW_AWS_VAULT_KEY' },
        },
      },
    },
  };
}

describe('packaged native S3 conformance', () => {
  it('refreshes instance-role credentials within one backend without static credentials', async () => {
    const directory = await fresh();
    const server = await localS3();
    try {
      const script = `const {awsS3StorageProvider:p}=await import(${JSON.stringify(path.join(plugin, 'index.js'))}); const b=await p.open({locationName:'vault',settings:${JSON.stringify(settings)},resolveSecret:async()=>{throw Error('Unexpected secret resolver')}}); try {for(let i=0;i<8;i++){await b.putObject('refresh-'+i,(async function*(){yield Buffer.from('data')})(),{sizeBytes:4});await new Promise(resolve=>setTimeout(resolve,10))}}finally{await b.close()}`;
      await execa(process.execPath, ['--input-type=module', '-e', script], {
        env: environment(directory, server.endpoint),
        extendEnv: false,
        timeout: 20000,
      });
      expect(server.credentialReads()).toBeGreaterThanOrEqual(2);
      expect(server.authorizations.some((value) => value.includes('FIXTUREKEYINITIAL'))).toBe(true);
      expect(server.authorizations.some((value) => value.includes('FIXTUREKEYREFRESHED'))).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  }, 30000);

  it('loads the built plugin and encrypts, catalogs, fully verifies and stages a multi-agent native archive', async () => {
    const directory = await fresh();
    const server = await localS3();
    const env = environment(directory, server.endpoint);
    const state = env.OPENCLAW_STATE_DIR;
    const firstWorkspace = path.join(directory, 'workspaces/coordinator');
    const secondWorkspace = path.join(directory, 'workspaces/researcher');
    const secondRoot = path.join(directory, 'custom-agents/researcher');
    const config = {
      plugins: pluginConfig,
      storage: storageConfig(),
      agents: {
        ownership: 'explicit',
        defaults: { workspace: firstWorkspace },
        entries: {
          main: { workspace: firstWorkspace },
          researcher: { workspace: secondWorkspace, agentDir: secondRoot },
        },
      },
    };
    await mkdir(state, { recursive: true });
    for (const [dir, name] of [
      [firstWorkspace, 'coordinator'],
      [secondWorkspace, 'researcher'],
      [secondRoot, 'custom-agent-root'],
    ]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${name}.txt`), `${name}-recovery-proof`);
    }
    await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
    const run = async (...args: string[]) => {
      const result = await execa(process.execPath, [native, ...args, '--json'], {
        env,
        extendEnv: false,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    };
    try {
      const plugins = await run('plugins', 'list');
      expect(
        plugins.plugins.find((item: { id: string }) => item.id === 'openclaw-aws-s3').status,
      ).toBe('loaded');
      expect((await run('storage', 'init', 'vault')).state).toBe('ok');
      expect((await run('storage', 'test', 'vault')).state).toBe('ok');
      const created = await run('backup', 'create', '--to', 'vault', '--namespace', 'team-fixture');
      const key = created.location.key;
      const listed = await run('backup', 'list', '--from', 'vault', '--namespace', 'team-fixture');
      expect(listed.backups.some((item: { key: string }) => item.key === key)).toBe(true);
      const versions = Object.fromEntries(
        [...server.objects].flatMap(([name, items]) => {
          const item = items.at(-1);
          return item && !item.deleted ? [[name.slice('vault/main/'.length), item.id]] : [];
        }),
      );
      const storedArchive = server.objects.get(`vault/main/backups/team-fixture/${key}`)!.at(-1)!;
      expect(storedArchive.body.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);
      config.storage = storageConfig({ readOnly: true, readVersions: versions });
      await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
      // Hide the current archive behind a delete marker; recovery must use its committed version.
      server.objects
        .get(`vault/main/backups/team-fixture/${key}`)!
        .push({ id: 'deleted-current', body: Buffer.alloc(0), deleted: true });
      const verified = await run(
        'backup',
        'verify',
        key,
        '--from',
        'vault',
        '--namespace',
        'team-fixture',
      );
      expect(verified).toBeTruthy();
      const target = path.join(directory, 'restored');
      const restored = await run(
        'backup',
        'restore',
        key,
        '--from',
        'vault',
        '--namespace',
        'team-fixture',
        '--target',
        target,
      );
      expect(restored).toBeTruthy();
      const files = await readdir(target, { recursive: true });
      for (const name of ['coordinator', 'researcher', 'custom-agent-root']) {
        const relative = files.find((file) => file.endsWith(`${name}.txt`));
        expect(relative, `${name} was omitted from native recovery`).toBeDefined();
        expect(await readFile(path.join(target, relative!), 'utf8')).toBe(`${name}-recovery-proof`);
      }
    } finally {
      await server.close();
    }
  }, 180000);
});
