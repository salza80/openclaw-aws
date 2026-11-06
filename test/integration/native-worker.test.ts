import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { localS3 } from '../helpers/s3-server.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
describe('actual native host capture adapter', () => {
  it('preserves native settings, uses instance-role storage despite model credentials and verifies the remote archive', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'openclaw-worker-native-')));
    const server = await localS3();
    const state = path.join(directory, '.openclaw');
    const workspace = path.join(directory, 'workspace');
    const configPath = path.join(state, 'openclaw.json');
    await mkdir(state);
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'work.txt'), 'member-state');
    await writeFile(
      path.join(state, '.env'),
      'OPENROUTER_API_KEY=fixture-provider\nAWS_ACCESS_KEY_ID=MODELKEY\nAWS_SECRET_ACCESS_KEY=model-secret\n',
      { mode: 0o600 },
    );
    const original = {
      agents: {
        ownership: 'explicit',
        defaults: { model: { primary: 'openrouter/fixture-model' } },
        entries: { main: { workspace } },
      },
      storage: {
        locations: {
          existing: {
            provider: 'filesystem',
            settings: { path: path.join(directory, 'local-vault') },
            encryption: 'none',
          },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(original), { mode: 0o600 });
    const job = {
      schemaVersion: 1,
      operationId: '11111111-1111-1111-1111-111111111111',
      source: {
        stackId:
          'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-fixture/stack-guid',
        instanceId: 'i-0123456789abcdef0',
        roleId: 'AROA-FIXTURE',
        account: '123456789012',
        region: 'eu-central-1',
      },
      settings: {
        bucket: 'private-backups',
        prefix: 'vault/main',
        region: 'eu-central-1',
        expectedBucketOwner: '123456789012',
        credentialSource: 'instance-role',
      },
      key: {
        arn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:vault-abcdef',
        versionId: '11111111-1111-1111-1111-111111111111',
        versionStage: `openclaw-aws-vault-${'a'.repeat(32)}`,
      },
      pluginDirectory: path.join(root, 'dist/native-plugins/aws-s3'),
      namespace: 'fixture',
    };
    const script = `
      import {nativeBackupHost} from ${JSON.stringify(path.join(root, 'dist/openclaw/native-backup-host.js'))};
      import {captureInstallation} from ${JSON.stringify(path.join(root, 'dist/openclaw/capture-worker.js'))};
      import {stageNativeRestore} from ${JSON.stringify(path.join(root, 'dist/openclaw/native-restore-host.js'))};
      import {createRequire} from 'node:module'; const {S3Client,HeadObjectCommand,GetObjectCommand}=createRequire(${JSON.stringify(path.join(root, 'package.json'))})('@aws-sdk/client-s3');
      const job=${JSON.stringify(job)};
      const host=await nativeBackupHost(job,{nativePackageJson:${JSON.stringify(path.join(root, 'node_modules/openclaw/package.json'))},gateway:{inspect:async()=> 'inactive',stop:async()=>{throw Error('Inactive Gateway must not be stopped')},start:async()=>{throw Error('Inactive Gateway must not be started')}}});
      for(const key of ['prepareStorage','members','capture','credentials','verify']){const method=host[key];host[key]=async(...args)=>{try{return await method(...args)}catch(error){console.error('Fixture phase '+key+': '+error.message);throw error}}}
      const client=new S3Client({region:job.source.region,credentials:{accessKeyId:'FIXTUREKEYOPERATOR',secretAccessKey:'fixture-secret'}});
      const common={Bucket:job.settings.bucket,ExpectedBucketOwner:job.source.account};
      const pin=async key=>{const r=await client.send(new HeadObjectCommand({...common,Key:job.settings.prefix+'/'+key}));return{versionId:r.VersionId,storedBytes:r.ContentLength}};
      let captured;
      const storage={identify:async()=>{},passphrase:async()=> 'fixture-vault-key\\0\\n',marker:async id=>{const p=await pin('openclaw-storage.json'); const r=await client.send(new GetObjectCommand({...common,Key:job.settings.prefix+'/openclaw-storage.json',VersionId:p.versionId}));if(JSON.parse(await r.Body.transformToString()).locationId!==id)throw Error('marker mismatch');return p},archive:async capture=>pin('backups/'+job.namespace+'/'+capture.location.key),publish:async result=>{captured=result;console.log(JSON.stringify(result));return{key:'capture.json',versionId:'fixture-result'}},close:()=>client.destroy()};
      try{await captureInstallation(job,host,storage,{enter:async record=>record,release:async()=>{}});
        const staged=await stageNativeRestore({job,capture:captured,passphrase:'fixture-vault-key\\0\\n',pluginDirectory:job.pluginDirectory,stagingDirectory:${JSON.stringify(path.join(directory, 'restore-stage'))},nativePackageJson:${JSON.stringify(path.join(root, 'node_modules/openclaw/package.json'))},home:${JSON.stringify(directory)}});
        if(staged.moves.length!==captured.capture.assets.length)throw Error('Native staged inventory mismatch');
      }finally{storage.close()}
    `;
    try {
      const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
        env: {
          HOME: directory,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          TMPDIR: directory,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: configPath,
          AWS_CONFIG_FILE: path.join(directory, 'empty-config'),
          AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'empty-credentials'),
          AWS_EC2_METADATA_SERVICE_ENDPOINT: server.endpoint,
          AWS_EC2_METADATA_V1_DISABLED: 'true',
          AWS_ENDPOINT_URL_S3: server.endpoint,
          NO_COLOR: '1',
        },
        extendEnv: false,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
      const captured = JSON.parse(result.stdout);
      expect(captured.verification.ok).toBe(true);
      expect(captured.gateway).toEqual({ initial: 'inactive', restored: true });
      expect(captured.members[0].id).toBe('main');
      expect(captured.credentials.sourceEnvironmentIncluded).toBe(true);
      expect(result.stdout).not.toContain('model-secret');
      expect(result.stdout).not.toContain('fixture-provider');
      expect(server.authorizations.some((value) => value.includes('MODELKEY'))).toBe(false);
      const after = JSON.parse(await readFile(configPath, 'utf8'));
      expect(after.agents).toEqual(original.agents);
      expect(after.storage.locations.existing).toEqual(original.storage.locations.existing);
      expect(await readFile(path.join(state, '.env'), 'utf8')).toContain(
        'AWS_ACCESS_KEY_ID=MODELKEY',
      );
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 150000);
});
