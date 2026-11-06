import { describe, expect, it } from 'vitest';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { parse as parseDotenv } from 'dotenv';
import { localS3 } from '../helpers/s3-server.js';
import { installRestoreLayout, planRestoreLayout } from '../../src/openclaw/restore-layout.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
describe('actual native host capture adapter', () => {
  it.each(['backup', 'archive'])(
    '%s preserves native settings, uses role storage and restores the whole native installation',
    async (mode) => {
      const directory = await realpath(
        await mkdtemp(path.join(tmpdir(), 'openclaw-worker-native-')),
      );
      const server = await localS3();
      const state = path.join(directory, '.openclaw');
      const workspace = path.join(directory, 'workspace');
      const researchWorkspace = path.join(directory, 'research-workspace');
      const researchAgent = path.join(directory, 'research-agent');
      const configPath = path.join(state, 'openclaw.json');
      await mkdir(state);
      await mkdir(workspace);
      await mkdir(researchWorkspace);
      await mkdir(researchAgent);
      await writeFile(path.join(workspace, 'work.txt'), 'member-state');
      await writeFile(path.join(researchWorkspace, 'research.txt'), 'research-state');
      await writeFile(path.join(researchAgent, 'memory.txt'), 'custom-agent-state');
      await writeFile(
        path.join(state, '.env'),
        'OPENROUTER_API_KEY=fixture-provider\nAWS_ACCESS_KEY_ID=MODELKEY\nAWS_SECRET_ACCESS_KEY=model-secret\n',
        { mode: 0o600 },
      );
      const original = {
        agents: {
          ownership: 'explicit',
          defaults: { model: { primary: 'openrouter/fixture-model' } },
          entries: {
            main: { workspace },
            researcher: {
              workspace: researchWorkspace,
              agentDir: researchAgent,
              model: 'openrouter/research-model',
            },
          },
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
          roleId: 'AROATESTHOSTROLE000001',
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
      import {archiveServiceHold} from ${JSON.stringify(path.join(root, 'dist/openclaw/archive-service-hold.js'))};
      import {archiveMemberIdentity,backupJobDigest} from ${JSON.stringify(path.join(root, 'dist/openclaw/backup-contract.js'))};
      import {createPrivateControlRecord} from ${JSON.stringify(path.join(root, 'dist/openclaw/model-journal.js'))};
      import {createRequire} from 'node:module'; const {S3Client,HeadObjectCommand,GetObjectCommand}=createRequire(${JSON.stringify(path.join(root, 'package.json'))})('@aws-sdk/client-s3');
      const job=${JSON.stringify(job)};
      const sessions=await import(${JSON.stringify(path.join(root, 'node_modules/openclaw/dist/plugin-sdk/session-store-runtime.js'))});
      const storePath=${JSON.stringify(path.join(state, 'agents/main/agent/openclaw-agent.sqlite'))};
      await sessions.upsertSessionEntry({agentId:'main',storePath,sessionKey:'agent:main:recovered-history',entry:{sessionId:'22222222-2222-2222-2222-222222222222',updatedAt:Date.now(),status:'interrupted',abortedLastRun:true}});
      const host=await nativeBackupHost(job,{nativePackageJson:${JSON.stringify(path.join(root, 'node_modules/openclaw/package.json'))},gateway:{inspect:async()=> 'inactive',stop:async()=>{throw Error('Inactive Gateway must not be stopped')},start:async()=>{throw Error('Inactive Gateway must not be started')}}});
      let archiveControl,maintenanceReleased=0;
      if(${JSON.stringify(mode)}==='archive'){
        const fileOps=await import('node:fs/promises'),path=await import('node:path');
        const home=${JSON.stringify(directory)},unit=path.join(home,'.config/systemd/user/openclaw-gateway.service');
        await fileOps.mkdir(path.dirname(unit),{recursive:true,mode:0o700});
        await fileOps.writeFile(unit,'[Service]\\nExecStart=/fixture/owned-gateway\\n',{mode:0o600});
        job.archive={deploymentName:'fixture',expectedMembers:archiveMemberIdentity(await host.members())};
        const hold=await archiveServiceHold({home,operationId:job.operationId,requestDigest:backupJobDigest(job),service:{inspect:async()=>({state:'inactive',masked:(await fileOps.lstat(unit)).isSymbolicLink()}),reload:async()=>{},stop:async()=>{throw Error('Inactive source must not be stopped')},start:async()=>{throw Error('Held archive source must not be started')}}});
        archiveControl={resume:async()=>undefined,begin:async initial=>{await hold.prepare(initial);await hold.hold()},assertHeld:()=>hold.assertHeld(),verified:async capture=>{await hold.assertHeld();await createPrivateControlRecord(path.join(home,'.openclaw-aws/jobs',job.operationId,'archive-capture-verified.json'),{capture})},restore:()=>hold.restore(),close:()=>{}};
      }
      for(const key of ['prepareStorage','members','capture','credentials','verify']){const method=host[key];host[key]=async(...args)=>{try{return await method(...args)}catch(error){console.error('Fixture phase '+key+': '+error.message);throw error}}}
      const client=new S3Client({region:job.source.region,credentials:{accessKeyId:'FIXTUREKEYOPERATOR',secretAccessKey:'fixture-secret'}});
      const common={Bucket:job.settings.bucket,ExpectedBucketOwner:job.source.account};
      const pin=async key=>{const r=await client.send(new HeadObjectCommand({...common,Key:job.settings.prefix+'/'+key}));return{versionId:r.VersionId,storedBytes:r.ContentLength}};
      let captured;
      const storage={identify:async()=>{},passphrase:async()=> 'fixture-vault-key\\0\\n',marker:async id=>{const p=await pin('openclaw-storage.json'); const r=await client.send(new GetObjectCommand({...common,Key:job.settings.prefix+'/openclaw-storage.json',VersionId:p.versionId}));if(JSON.parse(await r.Body.transformToString()).locationId!==id)throw Error('marker mismatch');return p},archive:async capture=>pin('backups/'+job.namespace+'/'+capture.location.key),publish:async result=>{captured=result;console.log(JSON.stringify(result));return{key:'capture.json',versionId:'fixture-result'}},close:()=>client.destroy()};
      try{await captureInstallation(job,host,storage,{enter:async record=>record,release:async()=>{maintenanceReleased++}},archiveControl);
        if(archiveControl){await archiveControl.assertHeld();if(maintenanceReleased!==0)throw Error('Archive maintenance was prematurely released');}
        else if(maintenanceReleased!==1)throw Error('Ordinary backup did not release its source');
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
          timeout: 180000,
          maxBuffer: 1024 * 1024,
        });
        const captured = JSON.parse(result.stdout);
        expect(captured.verification.ok).toBe(true);
        if (mode === 'archive')
          expect(captured.gateway).toMatchObject({
            initial: 'inactive',
            restored: false,
            held: {
              kind: 'archive',
              operationId: job.operationId,
              requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          });
        else expect(captured.gateway).toEqual({ initial: 'inactive', restored: true });
        expect(captured.members[0].id).toBe('main');
        expect(captured.members.map((member: { id: string }) => member.id).sort()).toEqual([
          'main',
          'researcher',
        ]);
        expect(captured.credentials.sourceEnvironmentIncluded).toBe(true);
        expect(result.stdout).not.toContain('model-secret');
        expect(result.stdout).not.toContain('fixture-provider');
        expect(server.authorizations.some((value) => value.includes('MODELKEY'))).toBe(false);
        // Discard the source tree and source process. Adopt only the actual native
        // extraction with fresh installer-owned runtime paths on the same filesystem.
        await rename(state, path.join(directory, 'original-state'));
        await rename(workspace, path.join(directory, 'original-workspace'));
        await rename(researchWorkspace, path.join(directory, 'original-research-workspace'));
        await rename(researchAgent, path.join(directory, 'original-research-agent'));
        await mkdir(state);
        await mkdir(path.join(state, 'tools'));
        await mkdir(path.join(state, 'bin'));
        await mkdir(path.join(state, 'logs'));
        await writeFile(path.join(state, 'bin/openclaw'), 'fresh-runtime-wrapper');
        const stagingDirectory = path.join(directory, 'restore-stage');
        const manifest = JSON.parse(
          await readFile(
            path.join(stagingDirectory, captured.verification.archiveRoot, 'manifest.json'),
            'utf8',
          ),
        );
        const moves = planRestoreLayout({
          manifest,
          capture: captured,
          stagingDirectory,
          home: directory,
        });
        await installRestoreLayout({
          operationId: job.operationId,
          moves,
          journal: path.join(directory, 'restore-layout.json'),
          home: directory,
        });
        const restoredPlugin = path.join(directory, '.openclaw-aws/plugins', 'c'.repeat(64));
        await mkdir(restoredPlugin, { recursive: true, mode: 0o700 });
        for (const filename of [
          'index.js',
          'index.js.LEGAL.txt',
          'package.json',
          'openclaw.plugin.json',
          'THIRD-PARTY-LICENSES.txt',
        ])
          await copyFile(
            path.join(root, 'dist/native-plugins/aws-s3', filename),
            path.join(restoredPlugin, filename),
          );
        const reconciliation = `
        import {reconcileNativeRestore} from ${JSON.stringify(path.join(root, 'dist/openclaw/restore-reconciliation.js'))};
        const job=${JSON.stringify(job)},capture=${JSON.stringify(captured)},imported=[];
        const reconciliationOptions={job,capture,deploymentRegion:'eu-central-1',owner:{deploymentName:'restored',deploymentId:'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-restored/target-guid',operationId:job.operationId},gatewayToken:'a'.repeat(48),pluginDirectory:${JSON.stringify(restoredPlugin)},nativePackageJson:${JSON.stringify(path.join(root, 'node_modules/openclaw/package.json'))},assertInactive:async()=>{},ssm:{send:async command=>{imported.push(command.input);return{Version:1}}}};
        const reconciled=await reconcileNativeRestore(reconciliationOptions);
        if(reconciled.members.length!==capture.members.length||imported.length!==1||imported[0].Name!=='/openclaw/restored/providers/openrouter-api-key/api-key'||imported[0].Value!=='fixture-provider')throw Error('Native credential reconciliation mismatch');
        const sessions=await import(${JSON.stringify(path.join(root, 'node_modules/openclaw/dist/plugin-sdk/session-store-runtime.js'))});
        const held=await sessions.getSessionEntryAsync({agentId:'main',storePath:${JSON.stringify(path.join(state, 'agents/main/agent/openclaw-agent.sqlite'))},sessionKey:'agent:main:recovered-history'});
        if(reconciled.sessionHold.held!==1||held?.sessionId!=='22222222-2222-2222-2222-222222222222'||!held?.archivedAt)throw Error('Native restored session hold mismatch');
        const resumed=await reconcileNativeRestore(reconciliationOptions);
        if(resumed.sessionHold.held!==1||resumed.sessionHold.preexistingIncomplete!==0)throw Error('Native session hold retry changed ownership');
      `;
        await execa(process.execPath, ['--input-type=module', '-e', reconciliation], {
          env: {
            HOME: directory,
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            TMPDIR: directory,
            OPENCLAW_STATE_DIR: state,
            OPENCLAW_CONFIG_PATH: configPath,
            NO_COLOR: '1',
            AWS_CONFIG_FILE: path.join(directory, 'empty-config'),
            AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'empty-credentials'),
            AWS_EC2_METADATA_DISABLED: 'true',
          },
          extendEnv: false,
          timeout: 180000,
          maxBuffer: 1024 * 1024,
        });
        const after = JSON.parse(await readFile(configPath, 'utf8'));
        expect(after.agents).toEqual(original.agents);
        expect(after.storage.locations.existing).toEqual(original.storage.locations.existing);
        expect(after.gateway.auth).toMatchObject({
          mode: 'token',
          token: 'a'.repeat(48),
          allowTailscale: false,
        });
        expect(after.cron.enabled).toBe(false);
        expect(after.plugins.load.paths).toContain(restoredPlugin);
        expect(after.plugins.load.paths).not.toContain(job.pluginDirectory);
        expect(await readFile(path.join(state, 'bin/openclaw'), 'utf8')).toBe(
          'fresh-runtime-wrapper',
        );
        expect(await readFile(path.join(workspace, 'work.txt'), 'utf8')).toBe('member-state');
        expect(await readFile(path.join(researchWorkspace, 'research.txt'), 'utf8')).toBe(
          'research-state',
        );
        expect(await readFile(path.join(researchAgent, 'memory.txt'), 'utf8')).toBe(
          'custom-agent-state',
        );
        expect(parseDotenv(await readFile(path.join(state, '.env')))).toMatchObject({
          AWS_ACCESS_KEY_ID: 'MODELKEY',
          AWS_SECRET_ACCESS_KEY: 'model-secret',
          OPENROUTER_API_KEY: 'fixture-provider',
          OPENCLAW_GATEWAY_TOKEN: 'a'.repeat(48),
        });
      } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    420000,
  );
});
