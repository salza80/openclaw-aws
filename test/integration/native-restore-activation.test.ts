import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const root = fileURLToPath(new URL('../../', import.meta.url));
describe('native restored-session activation gate', () => {
  it('uses the native adoption hold to block a real interrupted turn after Gateway startup', async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'restore-activation-')));
    const state = path.join(home, '.openclaw');
    await mkdir(state);
    const workspace = path.join(home, 'workspace');
    await mkdir(workspace);
    let modelRequests = 0;
    const model = createHttpServer((request, response) => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404);
        response.end();
        return;
      }
      modelRequests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders(); // Keep the fake turn in flight until its Gateway crashes.
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const modelAddress = model.address();
    if (!modelAddress || typeof modelAddress === 'string') throw Error('No model fixture port');
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw Error('No Gateway fixture port');
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const token = 'a'.repeat(48);
    const configPath = path.join(state, 'openclaw.json');
    await writeFile(
      configPath,
      JSON.stringify({
        gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
        agents: {
          ownership: 'explicit',
          defaults: { model: { primary: 'fixture/model' } },
          entries: { main: { workspace } },
        },
        models: {
          mode: 'replace',
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
              api: 'openai-completions',
              apiKey: 'fixture-only-key',
              models: [{ id: 'model', name: 'Fixture', contextWindow: 32000, maxTokens: 100 }],
            },
          },
        },
        cron: { enabled: false, triggers: { enabled: false } },
        hooks: { enabled: false, internal: { enabled: false } },
      }),
      { mode: 0o600 },
    );
    const env = {
      HOME: home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: home,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_GATEWAY_TOKEN: token,
      NO_COLOR: '1',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
    };
    const packageJson = path.join(root, 'node_modules/openclaw/package.json');
    const native = path.join(root, 'node_modules/openclaw/openclaw.mjs');
    let gateway: ReturnType<typeof execa> | undefined;
    try {
      const setup = `
        import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
        const require=createRequire(${JSON.stringify(packageJson)});
        const sdk=await import(pathToFileURL(require.resolve('openclaw/plugin-sdk/session-store-runtime')).href);
        const storePath=${JSON.stringify(path.join(state, 'agents/main/agent/openclaw-agent.sqlite'))};
        await sdk.upsertSessionEntry({agentId:'main',storePath,sessionKey:'agent:main:retained',entry:{sessionId:'22222222-2222-2222-2222-222222222222',updatedAt:Date.now()}});
      `;
      await execa(process.execPath, ['--input-type=module', '-e', setup], {
        env,
        extendEnv: false,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      const start = async () => {
        gateway = execa(process.execPath, [native, 'gateway', 'run', `--port=${port}`], {
          env,
          extendEnv: false,
          reject: false,
          maxBuffer: 1024 * 1024,
        });
        const deadline = Date.now() + 60000;
        let healthy = false;
        while (
          Date.now() < deadline &&
          (gateway.exitCode === null || gateway.exitCode === undefined)
        ) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
              signal: AbortSignal.timeout(1000),
            });
            if (response.ok) {
              healthy = true;
              break;
            }
          } catch {
            /* Startup is bounded below. */
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!healthy) {
          gateway.kill('SIGTERM');
          const result = await gateway;
          throw Error(`Native fixture Gateway failed startup: ${result.stderr}`);
        }
      };
      await start();
      const attempt = (idempotencyKey: string) =>
        execa(
          process.execPath,
          [
            native,
            'gateway',
            'call',
            'chat.send',
            '--params',
            JSON.stringify({
              sessionKey: 'agent:main:retained',
              message: 'local fixture admission check',
              idempotencyKey,
            }),
            '--json',
          ],
          { env, extendEnv: false, reject: false, timeout: 30000, maxBuffer: 1024 * 1024 },
        );
      const admitted = async (key: string) => {
        let response = await attempt(key);
        const deadline = Date.now() + 60000;
        while (
          Date.now() < deadline &&
          response.stdout.includes('agent-database-inspection-pending')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          response = await attempt(key);
        }
        return response;
      };
      const initial = await admitted('initial-fixture-admission');
      if (initial.exitCode !== 0)
        throw Error(`Local fixture turn was not admitted: ${initial.stdout} ${initial.stderr}`);
      const waitForModel = async (count: number) => {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && modelRequests < count)
          await new Promise((resolve) => setTimeout(resolve, 250));
        expect(modelRequests).toBe(count);
      };
      await waitForModel(1);
      gateway!.kill('SIGKILL');
      await gateway;
      await start();
      // Counterfactual: without the adoption hold, native recovery re-admits the crashed turn.
      await waitForModel(2);
      gateway!.kill('SIGKILL');
      await gateway;
      await execa(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `        const {holdRestoredSessions}=await import(${JSON.stringify(path.join(root, 'dist/openclaw/restore-session-hold.js'))});
        const result=await holdRestoredSessions({owner:{deploymentName:'restored',deploymentId:'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-restored/target-guid',operationId:'11111111-1111-1111-1111-111111111111'},members:[{id:'main',workspace:${JSON.stringify(workspace)},agentDir:${JSON.stringify(path.join(state, 'agents/main/agent'))}}],nativePackageJson:${JSON.stringify(packageJson)},journal:${JSON.stringify(path.join(home, '.openclaw-aws/jobs/hold.json'))},assertInactive:async()=>{}});
        if(result.held!==1)throw Error('No session hold');
`,
        ],
        { env, extendEnv: false, timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      await start();
      const blocked = await admitted('held-fixture-admission');
      expect(blocked.exitCode).not.toBe(0);
      expect(`${blocked.stdout}\n${blocked.stderr}`).toMatch(/archiv/i);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(modelRequests).toBe(2);
      const inspection = `import {inspectRestoredSessionHolds} from ${JSON.stringify(path.join(root, 'dist/openclaw/restore-session-hold.js'))};
        const result=await inspectRestoredSessionHolds({owner:{deploymentName:'restored',deploymentId:'arn:aws:cloudformation:eu-central-1:123456789012:stack/OpenclawStack-restored/target-guid',operationId:'11111111-1111-1111-1111-111111111111'},members:[{id:'main',workspace:${JSON.stringify(workspace)},agentDir:${JSON.stringify(path.join(state, 'agents/main/agent'))}}],nativePackageJson:${JSON.stringify(packageJson)},journal:${JSON.stringify(path.join(home, '.openclaw-aws/jobs/hold.json'))}});if(result.held!==1)throw Error('Running Gateway lost restored hold');`;
      await execa(process.execPath, ['--input-type=module', '-e', inspection], {
        env,
        extendEnv: false,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      const listed = await execa(
        process.execPath,
        [native, 'sessions', '--all-agents', '--limit=all', '--json'],
        { env, extendEnv: false, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      expect(
        JSON.parse(listed.stdout).sessions.some(
          (session: { sessionId?: string }) =>
            session.sessionId === '22222222-2222-2222-2222-222222222222',
        ),
      ).toBe(true);
      // Unarchive through the native public control plane is explicit consent to
      // resume this conversation. The saved incarnation and history stay intact.
      const restored = await execa(
        process.execPath,
        [
          native,
          'gateway',
          'call',
          'sessions.patch',
          '--params',
          JSON.stringify({
            key: 'agent:main:retained',
            expectedSessionId: '22222222-2222-2222-2222-222222222222',
            archived: false,
          }),
          '--json',
        ],
        { env, extendEnv: false, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      expect(restored.exitCode).toBe(0);
      const reviewed = await admitted('explicit-reviewed-task');
      expect(reviewed.exitCode).toBe(0);
      await waitForModel(3);
    } finally {
      if (gateway) {
        gateway.kill('SIGTERM');
        await gateway;
      }
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 240000);
});
