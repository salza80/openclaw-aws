import { describe, expect, it } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  changeModelSelection,
  inspectModelSelection,
  type NativeModelClient,
  type ModelMutationRecord,
} from '../../src/openclaw/model-control.js';
import { createNativeModelClient } from '../../src/openclaw/model-client.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
describe('native Gateway persistent model selection', () => {
  it.each(['main', 'coordinator'])(
    'verifies published selection, retained sessions and rollback with %s as the inheriting role',
    async (coordinator) => {
      const home = await realpath(await mkdtemp(path.join(tmpdir(), 'native-model-control-')));
      const state = path.join(home, '.openclaw');
      const configPath = path.join(state, 'openclaw.json');
      await mkdir(state, { mode: 0o700 });
      let inferenceRequests = 0;
      const model = httpServer((_request, response) => {
        inferenceRequests++;
        response.writeHead(403);
        response.end();
      });
      model.listen(0, '127.0.0.1');
      await once(model, 'listening');
      const modelAddress = model.address();
      if (!modelAddress || typeof modelAddress === 'string') throw Error('No fixture endpoint');
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      if (!address || typeof address === 'string') throw Error('No fixture Gateway port');
      const port = address.port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const native = path.join(root, 'node_modules/openclaw/openclaw.mjs');
      const packageJson = path.join(root, 'node_modules/openclaw/package.json');
      const env = {
        HOME: home,
        TMPDIR: home,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_GATEWAY_TOKEN: 'a'.repeat(48),
        NO_COLOR: '1',
        OPENCLAW_HIDE_BANNER: '1',
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true',
      };
      const config = {
        gateway: {
          mode: 'local',
          bind: 'loopback',
          port,
          auth: { mode: 'token', token: env.OPENCLAW_GATEWAY_TOKEN },
        },
        agents: {
          ownership: 'explicit',
          defaults: {
            model: { primary: 'fixture/one', fallbacks: ['fixture/fallback'] },
            skipBootstrap: true,
            heartbeat: { every: '0m' },
          },
          entries: Object.fromEntries(
            [coordinator, 'researcher', 'reviewer'].map((id) => [
              id,
              {
                workspace: path.join(home, id),
                ...(id === 'reviewer' ? { model: 'fixture/one' } : {}),
              },
            ]),
          ),
        },
        models: {
          mode: 'replace',
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
              api: 'openai-completions',
              apiKey: 'fixture-only-key',
              models: ['one', 'two', 'fallback'].map((id) => ({
                id,
                name: id,
                contextWindow: 32000,
                maxTokens: 100,
              })),
            },
          },
        },
        cron: { enabled: false, triggers: { enabled: false } },
        hooks: { enabled: false, internal: { enabled: false } },
      };
      for (const id of [coordinator, 'researcher', 'reviewer']) await mkdir(path.join(home, id));
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const sessionKey = 'agent:researcher:retained';
      const storePath = path.join(state, 'agents/researcher/agent/openclaw-agent.sqlite');
      const session = async (seed = false) => {
        const script = `
        import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
        const require=createRequire(${JSON.stringify(packageJson)});
        const sdk=await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
        const target={agentId:'researcher',storePath:${JSON.stringify(storePath)},sessionKey:${JSON.stringify(sessionKey)}};
        ${seed ? "await sdk.upsertSessionEntry({...target,entry:{sessionId:'22222222-2222-2222-2222-222222222222',updatedAt:Date.now(),modelOverride:'one',providerOverride:'fixture'}});" : ''}
        const entry=await sdk.getSessionEntryAsync({...target,readConsistency:'latest'});
        console.log(JSON.stringify({modelOverride:entry?.modelOverride,providerOverride:entry?.providerOverride}));`;
        const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
          env,
          extendEnv: false,
          timeout: 30000,
        });
        return JSON.parse(result.stdout);
      };
      let gateway: ReturnType<typeof execa> | undefined;
      const start = async () => {
        gateway = execa(process.execPath, [native, 'gateway', 'run', `--port=${port}`], {
          env,
          extendEnv: false,
          reject: false,
          forceKillAfterDelay: 5000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && gateway.exitCode == null) {
          try {
            if (
              (
                await fetch(`http://127.0.0.1:${port}/healthz`, {
                  signal: AbortSignal.timeout(1000),
                })
              ).ok
            )
              return;
          } catch {
            /* Bounded startup below. */
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw Error('Native model fixture Gateway did not start');
      };
      const stop = async () => {
        if (gateway) {
          gateway.kill('SIGTERM');
          await gateway;
          gateway = undefined;
        }
      };
      const records: ModelMutationRecord[] = [];
      let failHealth = false;
      const nativeClient = createNativeModelClient({
        home,
        packageJson,
        gatewayToken: env.OPENCLAW_GATEWAY_TOKEN,
        port,
        async restart() {
          await stop();
          await start();
        },
        async record(value) {
          records.push(structuredClone(value));
        },
      });
      const client: NativeModelClient = {
        ...nativeClient,
        async health() {
          if (failHealth) {
            failHealth = false;
            throw Error('Simulated failed post-change health');
          }
          await nativeClient.health();
        },
      };
      try {
        const retained = await session(true);
        await start();
        const originalPid = gateway!.pid;
        const scope = { kind: 'agent' as const, agentId: 'researcher' };
        const before = await inspectModelSelection(client, scope);
        expect(before).toMatchObject({
          configured: null,
          inherited: true,
          effectiveForNewSessions: 'fixture/one',
        });
        const changed = await changeModelSelection(client, {
          scope,
          model: 'fixture/two',
          expectedHash: before.configHash,
        });
        expect(changed.effectiveForNewSessions).toBe('fixture/two');
        expect(gateway!.pid).toBe(originalPid);
        expect(await session()).toEqual(retained);
        const after = JSON.parse(await readFile(configPath, 'utf8'));
        expect(after.agents.defaults.model).toEqual(config.agents.defaults.model);
        expect(after.agents.entries.reviewer.model).toBe('fixture/one');
        failHealth = true;
        await expect(
          changeModelSelection(client, {
            scope,
            model: 'fixture/one',
            expectedHash: changed.configHash,
          }),
        ).rejects.toMatchObject({ outcome: 'rolled-back' });
        expect((await inspectModelSelection(client, scope)).effectiveForNewSessions).toBe(
          'fixture/two',
        );
        expect(await session()).toEqual(retained);
        const currentDefault = await inspectModelSelection(client, { kind: 'default' });
        const global = await changeModelSelection(client, {
          scope: { kind: 'default' },
          model: 'fixture/two',
          expectedHash: currentDefault.configHash,
        });
        expect(global.effectiveForNewSessions).toBe('fixture/two');
        expect(
          (await inspectModelSelection(client, { kind: 'agent', agentId: 'reviewer' }))
            .effectiveForNewSessions,
        ).toBe('fixture/one');
        const reloadSnapshot = (await client.call('config.get', {})) as { hash: string };
        await client.call('config.patch', {
          baseHash: reloadSnapshot.hash,
          raw: JSON.stringify({ gateway: { reload: { mode: 'off' } } }),
          response: 'summary',
        });
        const disabled = await inspectModelSelection(client, scope);
        await expect(
          changeModelSelection(client, {
            scope,
            model: 'fixture/one',
            expectedHash: disabled.configHash,
          }),
        ).rejects.toMatchObject({ outcome: 'unchanged' });
        const previousPid = gateway!.pid;
        const restarted = await changeModelSelection(client, {
          scope,
          model: 'fixture/one',
          expectedHash: disabled.configHash,
          allowRestart: true,
        });
        expect(restarted).toMatchObject({
          restarted: true,
          effectiveForNewSessions: 'fixture/one',
        });
        expect(gateway!.pid).not.toBe(previousPid);
        expect(await session()).toEqual(retained);
        expect(JSON.stringify(records)).not.toContain('fixture-only-key');
        expect(inferenceRequests).toBe(0);
      } finally {
        await stop();
        model.closeAllConnections();
        await new Promise<void>((resolve) => model.close(() => resolve()));
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    240000,
  );
});
