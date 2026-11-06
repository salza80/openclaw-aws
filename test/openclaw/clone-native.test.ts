import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  lstat,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { planCloneContent } from '../../src/openclaw/clone-content.js';
import { installCloneWorkspaces } from '../../src/openclaw/clone-workspaces.js';
import { readCloneSourcePolicy } from '../../src/openclaw/clone-source.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe('fresh native independent clone', () => {
  it.each(['main', 'lead'])(
    'creates an independent %s/researcher roster with fresh credentials and disconnected integrations',
    async (coordinator) => {
      root = await realpath(await mkdtemp(path.join(tmpdir(), 'claw-native-clone-')));
      const target = path.join(root, 'target');
      const staging = path.join(root, 'staging');
      const sourceState = path.join(staging, 'state');
      const journal = path.join(target, 'journal');
      await mkdir(sourceState, { recursive: true });
      await mkdir(journal, { recursive: true, mode: 0o700 });
      const members = [coordinator, 'researcher'].map((id) => ({
        id,
        workspace: `/home/ubuntu/${id}`,
        agentDir: `/home/ubuntu/.openclaw/agents/${id}/agent`,
        model: id === coordinator ? 'openai/gpt-6-astra' : 'openrouter/auto',
      }));
      const sourceConfig = {
        agents: {
          ownership: 'explicit',
          defaults: {
            systemAgent: { agentId: 'researcher' },
            model: { primary: 'openrouter/auto' },
            models: { 'openai/gpt-6-astra': {}, 'openrouter/auto': {} },
          },
          entries: {
            [coordinator]: {
              name: 'Coordinator',
              model: { primary: 'openai/gpt-6-astra', fallbacks: ['openrouter/auto'] },
              models: { 'openai/gpt-6-astra': { agentRuntime: { id: 'openclaw' } } },
              subagents: { allowAgents: ['researcher'], delegationMode: 'prefer' },
            },
            researcher: { name: 'Researcher', tools: { profile: 'coding' } },
          },
        },
        tools: {
          agentToAgent: { enabled: true, allow: [coordinator, 'researcher'] },
          sessions: { visibility: 'all' },
        },
        channels: { telegram: { botToken: 'source-channel-token' } },
        cron: { enabled: true },
        secrets: {
          providers: {
            files: { source: 'file', path: `/home/ubuntu/${coordinator}/reference.json` },
          },
        },
      };
      await writeFile(path.join(sourceState, 'openclaw.json'), JSON.stringify(sourceConfig));
      await writeFile(path.join(sourceState, '.env'), 'OPENROUTER_API_KEY=source-provider-key\n');
      await writeFile(path.join(sourceState, 'state.sqlite'), 'opaque-source-identity');
      const moves = [{ source: sourceState, destination: '/home/ubuntu/.openclaw' }];
      for (const member of members) {
        const workshop = path.join(
          sourceState,
          'agents',
          member.id,
          'agent/workshop-skills/helper',
        );
        await mkdir(workshop, { recursive: true });
        await writeFile(path.join(workshop, 'SKILL.md'), 'file-backed private agent skill');
        await writeFile(path.join(workshop, 'run.sh'), '#!/bin/sh\necho clone-skill\n', {
          mode: 0o755,
        });
        const source = path.join(staging, member.id);
        await mkdir(path.join(source, 'memory'), { recursive: true });
        await writeFile(path.join(source, 'SOUL.md'), `persona for ${member.id}`);
        await writeFile(path.join(source, 'memory/project.md'), `knowledge for ${member.id}`);
        await writeFile(path.join(source, 'BOOTSTRAP.md'), 'must not replay');
        await writeFile(path.join(source, 'reference.json'), 'source-credential-content');
        moves.push({ source, destination: member.workspace });
      }
      const nativePackageJson = path.resolve('node_modules/openclaw/package.json');
      const policy = await readCloneSourcePolicy({
        configurationPath: '/home/ubuntu/.openclaw/openclaw.json',
        members,
        moves,
        stagingDirectory: staging,
        nativePackageJson,
      });
      const content = await planCloneContent({
        members,
        moves,
        stagingDirectory: staging,
        targetHome: target,
        credentialPaths: policy.credentialPaths,
      });
      await installCloneWorkspaces({
        operationId: '12345678-1234-1234-1234-123456789abc',
        plan: content,
        journal: path.join(journal, 'content.json'),
        home: target,
      });
      const request = path.join(root, 'request.json');
      await writeFile(
        request,
        JSON.stringify({
          content,
          policy,
          apiProvider: 'openrouter-api-key',
          providerCredential: 'fresh-fixture-provider-key',
          additionalCredentials: {
            'openai-api-key': 'sk-proj-fixture-not-a-real-openai-key-1234567890',
          },
          gatewayToken: 'b'.repeat(48),
          nativePackageJson,
        }),
        { mode: 0o600 },
      );
      const module = pathToFileURL(path.resolve('dist/openclaw/clone-native.js')).href;
      const script = `import {readFile} from 'node:fs/promises';
      const {initializeNativeClone}=await import(${JSON.stringify(module)});
      const options=JSON.parse(await readFile(process.argv[1],'utf8'));
      const result=await initializeNativeClone({...options,assertInactive:async()=>{}});
      process.stdout.write(JSON.stringify(result));`;
      const result = await execa(process.execPath, ['--input-type=module', '-e', script, request], {
        env: {
          HOME: target,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: path.join(target, '.openclaw'),
          OPENCLAW_CONFIG_PATH: path.join(target, '.openclaw/openclaw.json'),
          OPENCLAW_DEFER_SHELL_ENV_FALLBACK: '1',
          NO_COLOR: '1',
          OPENCLAW_HIDE_BANNER: '1',
        },
        extendEnv: false,
        timeout: 240000,
        maxBuffer: 1024 * 1024,
      });
      expect(
        JSON.parse(result.stdout)
          .members.map((member: { id: string }) => member.id)
          .sort(),
      ).toEqual([coordinator, 'researcher']);
      const config = JSON.parse(
        await readFile(path.join(target, '.openclaw/openclaw.json'), 'utf8'),
      );
      expect(config.agents.defaults.systemAgent).toEqual({ agentId: 'researcher' });
      expect(config.agents.entries[coordinator].subagents).toEqual({
        allowAgents: ['researcher'],
        delegationMode: 'prefer',
      });
      expect(config.agents.entries.researcher.tools).toEqual({ profile: 'coding' });
      expect(config.tools.agentToAgent).toEqual({
        enabled: true,
        allow: [coordinator, 'researcher'],
      });
      expect(config.agents.defaults.heartbeat.every).toBe('0m');
      expect(config.memory.search.enabled).toBe(false);
      expect(config.channels).toEqual({});
      expect(config.mcp.servers).toEqual({});
      expect(config.cron.enabled).toBe(false);
      expect(config.hooks.enabled).toBe(false);
      expect(JSON.stringify(config)).not.toContain('source-');
      const environment = await readFile(path.join(target, '.openclaw/.env'), 'utf8');
      expect(environment).toContain('fresh-fixture-provider-key');
      expect(environment).toContain('sk-proj-fixture-not-a-real-openai-key-1234567890');
      expect(environment).not.toContain('source-');
      for (const member of members) {
        const workspace = path.join(target, '.openclaw/workspaces', member.id);
        expect(await readFile(path.join(workspace, 'SOUL.md'), 'utf8')).toBe(
          `persona for ${member.id}`,
        );
        expect(await readFile(path.join(workspace, 'memory/project.md'), 'utf8')).toBe(
          `knowledge for ${member.id}`,
        );
        expect(await readdir(workspace)).not.toContain('BOOTSTRAP.md');
        const workshop = path.join(
          target,
          '.openclaw/agents',
          member.id,
          'agent/workshop-skills/helper',
        );
        expect(await readFile(path.join(workshop, 'SKILL.md'), 'utf8')).toBe(
          'file-backed private agent skill',
        );
        expect((await lstat(path.join(workshop, 'run.sh'))).mode & 0o777).toBe(0o700);
        expect((await execa(path.join(workshop, 'run.sh'))).stdout).toBe('clone-skill');
      }
      expect(await readdir(path.join(target, '.openclaw/workspaces', coordinator))).not.toContain(
        'reference.json',
      );
      expect(await readFile(path.join(sourceState, 'openclaw.json'), 'utf8')).toBe(
        JSON.stringify(sourceConfig),
      );
      expect(await readFile(path.join(sourceState, 'state.sqlite'), 'utf8')).toBe(
        'opaque-source-identity',
      );
      await expect(
        execa(process.execPath, ['--input-type=module', '-e', script, request], {
          env: { HOME: target, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
          extendEnv: false,
          timeout: 30000,
        }),
      ).rejects.toThrow('fresh native configuration');
    },
    300000,
  );
});
