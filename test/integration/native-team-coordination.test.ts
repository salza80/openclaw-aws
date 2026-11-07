import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { parseTeamDefinition, teamMembers } from '../../src/openclaw/team-definition.js';
import { createNativeModelClient } from '../../src/openclaw/model-client.js';
import { runTeamOperation } from '../../src/openclaw/team-worker.js';
import { parseTeamJob } from '../../src/openclaw/team-contract.js';
import { parseMembers } from '../../src/openclaw/backup-contract.js';
import { modelJob } from '../helpers/model-operation.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
describe('native configured team coordination', () => {
  it('passes actual researcher findings to a reviewer and collects both replies through native send-only permissions', async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'native-team-')));
    const events: { role: string; send?: string; reply?: string }[] = [];
    const finding = 'FINDING: The fixture result is 42.';
    const approved = 'APPROVED: The researcher result 42 is correct.';
    const final = 'FINAL: Researcher found 42; reviewer approved 42.';
    const model = createServer(async (request, response) => {
      try {
        if (!request.url?.endsWith('/chat/completions')) {
          response.writeHead(404);
          response.end();
          return;
        }
        let body = '';
        for await (const bytes of request) body += bytes;
        const input = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
        const system = JSON.stringify(
          input.messages.filter((message) => message.role === 'system'),
        );
        const role = system.includes('TEAMROLE_researcher')
          ? 'researcher'
          : system.includes('TEAMROLE_reviewer')
            ? 'reviewer'
            : 'main';
        const results = input.messages.filter((message) => message.role === 'tool');
        let content: string | undefined;
        let send: { agentId: string; message: string; timeoutSeconds: number } | undefined;
        if (role === 'researcher') content = finding;
        else if (role === 'reviewer')
          content = JSON.stringify(input.messages).includes(finding)
            ? approved
            : 'REJECTED: Actual researcher reply was missing.';
        else if (results.length === 0)
          send = {
            agentId: 'researcher',
            message: 'Research the fixture result and reply with your finding.',
            timeoutSeconds: 60,
          };
        else if (results.length === 1)
          send = {
            agentId: 'reviewer',
            message: 'Review this actual researcher reply: ' + String(results[0].content),
            timeoutSeconds: 60,
          };
        else
          content =
            String(results[0].content).includes(finding) &&
            String(results[1].content).includes(approved)
              ? final
              : 'FAILED: Actual peer replies were not collected.';
        events.push({ role, ...(send ? { send: send.agentId } : { reply: content }) });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = {
          id: 'fixture-' + events.length,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'model',
        };
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            'data: ' +
              JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) +
              '\n\n',
          );
        chunk(
          send
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-' + events.length,
                    type: 'function',
                    function: {
                      name: 'dispatch_action',
                      arguments: JSON.stringify({ id: 'sessions_send', args: send }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content },
        );
        chunk({}, send ? 'tool_calls' : 'stop');
        response.end('data: [DONE]\n\n');
      } catch {
        response.writeHead(500);
        response.end('Local model fixture failed');
      }
    });
    let gateway: ReturnType<typeof execa> | undefined;
    try {
      model.listen(0, '127.0.0.1');
      await once(model, 'listening');
      const modelAddress = model.address();
      if (!modelAddress || typeof modelAddress === 'string') throw Error('No fixture model port');
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      if (!address || typeof address === 'string') throw Error('No Gateway fixture port');
      const port = address.port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const state = path.join(home, '.openclaw');
      await mkdir(state);
      const definition = parseTeamDefinition({
        schemaVersion: 1,
        topology: 'single-host',
        coordinator: 'lead',
        members: [
          {
            id: 'lead',
            role: 'Coordinator',
            instructions: 'TEAMROLE_main\nCollect actual researcher and reviewer replies.',
          },
          {
            id: 'researcher',
            role: 'Researcher',
            model: 'fixture/model',
            instructions: 'TEAMROLE_researcher\nResearch the fixture request.',
          },
          {
            id: 'reviewer',
            role: 'Reviewer',
            instructions: 'TEAMROLE_reviewer\nReview actual researcher findings.',
          },
        ],
      });
      const members = teamMembers(definition, home, {
        id: 'main',
        workspace: path.join(state, 'workspace'),
        agentDir: path.join(state, 'agents/main/agent'),
      });
      for (const member of members.filter((member) => member.id === 'main')) {
        await mkdir(member.workspace, { recursive: true });
        await writeFile(
          path.join(member.workspace, 'AGENTS.md'),
          'Fresh coordinator instructions awaiting approved team setup.\n',
        );
      }
      const token = 'c'.repeat(48);
      const config = {
        gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
        agents: {
          ownership: 'explicit',
          defaults: { model: { primary: 'fixture/model' }, skipBootstrap: true },
          entries: Object.fromEntries(
            members
              .filter((member) => member.id === 'main')
              .map((member) => [
                member.id,
                { workspace: member.workspace, agentDir: member.agentDir },
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
              models: [{ id: 'model', name: 'Fixture', contextWindow: 32000, maxTokens: 500 }],
            },
          },
        },
        cron: { enabled: false, triggers: { enabled: false } },
        hooks: { enabled: false, internal: { enabled: false } },
      };
      const configPath = path.join(state, 'openclaw.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
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
      const native = path.join(root, 'node_modules/openclaw/openclaw.mjs');
      // Same public fresh-bootstrap writer: the main-owned credential is a
      // shared read-through base for subsequently created native roles.
      await execa(process.execPath, [native, 'plugins', 'enable', 'openrouter'], {
        env,
        extendEnv: false,
        timeout: 60000,
      });
      await execa(
        process.execPath,
        [native, 'models', 'auth', 'paste-api-key', '--provider', 'openrouter', '--agent', 'main'],
        {
          env,
          extendEnv: false,
          input: 'fixture-shared-openrouter-key\n',
          timeout: 60000,
        },
      );
      gateway = execa(process.execPath, [native, 'gateway', 'run', `--port=${port}`], {
        env,
        extendEnv: false,
        reject: false,
        maxBuffer: 1024 * 1024,
      });
      const deadline = Date.now() + 60000;
      let healthy = false;
      while (Date.now() < deadline && gateway.exitCode === undefined) {
        try {
          if (
            (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }))
              .ok
          ) {
            healthy = true;
            break;
          }
        } catch {
          /* Bounded local startup. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!healthy) throw Error('Configured native team Gateway did not become healthy');
      const client = createNativeModelClient({
        home,
        packageJson: path.join(root, 'node_modules/openclaw/package.json'),
        gatewayToken: token,
        port,
        record: async () => {},
      });
      const methods: string[] = [];
      const host = {
        home,
        identify: async () => {},
        client: {
          ...client,
          call: async (method: string, params: Record<string, unknown>) => {
            methods.push(method);
            return client.call(method, params);
          },
        },
        members: async () =>
          parseMembers(
            JSON.parse(
              (
                await execa(process.execPath, [native, 'agents', 'list', '--json'], {
                  env,
                  extendEnv: false,
                  timeout: 30000,
                  maxBuffer: 1024 * 1024,
                })
              ).stdout,
            ),
          ),
      };
      const previewJob = parseTeamJob({
        schemaVersion: 1,
        kind: 'native-team',
        operationId: modelJob.operationId,
        teamId: modelJob.operationId,
        target: modelJob.target,
        runtime: modelJob.runtime,
        bedrockRole: false,
        definition,
        action: { kind: 'preview' },
      });
      const preview = await runTeamOperation(previewJob, host, 'execute');
      if (!('preflight' in preview)) throw Error('No native team preview');
      const job = parseTeamJob({
        ...previewJob,
        operationId: '22222222-2222-2222-2222-222222222222',
        action: { kind: 'configure', allowRestart: false, ...preview.preflight },
      });
      const configured = await runTeamOperation(job, host, 'execute');
      expect(configured).toMatchObject({
        recordedPhase: 'complete',
        requestedConfigurationVerified: true,
        maintenanceHeld: false,
        inferenceVerified: false,
      });
      expect(JSON.stringify(configured)).not.toContain('fixture-only-key');
      await expect(runTeamOperation(job, host, 'resume')).resolves.toMatchObject({
        recordedPhase: 'complete',
        requestedConfigurationVerified: true,
        maintenanceHeld: false,
      });
      expect(methods.filter((method) => method === 'config.patch')).toHaveLength(2);
      const authStatus = JSON.parse(
        (
          await execa(
            process.execPath,
            [native, 'models', 'status', '--agent', 'researcher', '--json'],
            {
              env,
              extendEnv: false,
              timeout: 60000,
              maxBuffer: 1024 * 1024,
            },
          )
        ).stdout,
      );
      const shared = authStatus.auth.providers.find(
        (provider: { provider: string }) => provider.provider === 'openrouter',
      );
      expect(shared.profiles.count).toBeGreaterThan(0);
      const result = await execa(
        process.execPath,
        [
          native,
          'agent',
          '--agent',
          'main',
          '--message',
          'Ask the researcher for its finding, pass that actual finding to the reviewer and collect both replies.',
          '--json',
          '--timeout',
          '150',
        ],
        { env, extendEnv: false, timeout: 180000, maxBuffer: 1024 * 1024 },
      );
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe('ok');
      expect(output.result.meta.toolSummary.failures).toBe(0);
      expect(output.result.meta.agentMeta.terminalReceipt.successfulToolNames).toContain(
        'sessions_send',
      );
      expect(events).toEqual([
        { role: 'main', send: 'researcher' },
        { role: 'researcher', reply: finding },
        { role: 'main', send: 'reviewer' },
        { role: 'reviewer', reply: approved },
        { role: 'main', reply: final },
      ]);
      expect(
        output.result.payloads.some((payload: { text: string }) => payload.text === final),
      ).toBe(true);
    } finally {
      gateway?.kill('SIGTERM');
      if (gateway) await gateway;
      model.closeAllConnections();
      if (model.listening) await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 250000);
});
