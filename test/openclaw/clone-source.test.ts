import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import {
  archivedClonePath,
  prepareCloneConfigView,
  readCloneSourcePolicy,
} from '../../src/openclaw/clone-source.js';

const nativePackageJson = path.resolve('node_modules/openclaw/package.json');
const parser = createRequire(nativePackageJson)('json5');
let root: string;
let staging: string;
let state: string;
let view: string;
const members = [
  {
    id: 'main',
    workspace: '/home/ubuntu/main',
    agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
  },
];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'claw-clone-source-')));
  staging = path.join(root, 'staging');
  state = path.join(staging, 'payload/state');
  view = path.join(root, 'view');
  await mkdir(state, { recursive: true });
  await mkdir(view, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const input = () => ({
  configurationPath: '/home/ubuntu/.openclaw/openclaw.json',
  members,
  stagingDirectory: staging,
  moves: [{ source: state, destination: '/home/ubuntu/.openclaw' }],
  viewDirectory: view,
  parse: parser.parse,
});

describe('isolated archived clone configuration', () => {
  it('inspects a multi-agent archive without probing original host directories', async () => {
    const roster = [
      members[0],
      {
        ...members[0],
        id: 'researcher',
        agentDir: '/home/ubuntu/.openclaw/agents/researcher/agent',
      },
    ];
    await mkdir(path.join(state, 'agents/main/agent'), { recursive: true });
    await mkdir(path.join(state, 'agents/researcher/agent'), { recursive: true });
    await writeFile(
      path.join(state, 'openclaw.json'),
      JSON.stringify({ agents: { $include: './roles.json5' } }),
    );
    const source = JSON.stringify({
      ownership: 'explicit',
      entries: Object.fromEntries(
        roster.map((member) => [
          member.id,
          { agentDir: member.agentDir, model: 'openrouter/auto' },
        ]),
      ),
    });
    await writeFile(path.join(state, 'roles.json5'), source);
    const policy = await readCloneSourcePolicy({
      ...input(),
      members: roster,
      nativePackageJson,
      signal: AbortSignal.timeout(6000),
    });
    expect(policy.agents.map((agent) => agent.id).sort()).toEqual(['main', 'researcher']);
    expect(JSON.stringify(policy)).not.toContain(staging);
    expect(await readFile(path.join(state, 'roles.json5'), 'utf8')).toBe(source);
  }, 15000);
  it('refuses member paths that disagree with capture or link outside the archive', async () => {
    const config = { agents: { entries: { main: { agentDir: members[0].agentDir } } } };
    await writeFile(path.join(state, 'openclaw.json'), JSON.stringify(config));
    await mkdir(path.join(state, 'agents/main'), { recursive: true });
    await symlink(root, path.join(state, 'agents/main/agent'));
    await expect(prepareCloneConfigView(input())).rejects.toThrow('outside the verified backup');
    await rm(path.join(state, 'agents/main/agent'));
    config.agents.entries.main.agentDir = '/home/ubuntu/another-agent';
    await writeFile(path.join(state, 'openclaw.json'), JSON.stringify(config));
    await expect(prepareCloneConfigView(input())).rejects.toThrow(
      'differs from its verified backup',
    );
  });
  it('ships a read-only bundled preview with no physical staging paths or source/operator credentials in the result', async () => {
    const original = JSON.stringify({
      agents: { ownership: 'explicit', entries: { main: { model: 'openrouter/auto' } } },
    });
    await writeFile(path.join(state, 'openclaw.json'), original);
    await writeFile(path.join(state, '.env'), 'OPENROUTER_API_KEY=source-private-provider-key\n');
    const workspace = path.join(staging, 'payload/workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'SOUL.md'), 'cloned persona');
    await writeFile(path.join(workspace, '.env'), 'source-private-channel-key');
    const request = path.join(view, 'request.json');
    const result = path.join(view, 'result.json');
    await writeFile(
      request,
      JSON.stringify({
        ...input(),
        schemaVersion: 1,
        members,
        nativePackageJson,
        moves: [...input().moves, { source: workspace, destination: members[0].workspace }],
      }),
      { mode: 0o600 },
    );
    const args = [
      path.resolve('dist/native-plugins/aws-s3/restore-worker.js'),
      '--preview-clone',
      request,
      result,
    ];
    const options = {
      env: {
        HOME: path.join(root, 'operator'),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        OPENAI_API_KEY: 'operator-private-provider-key',
      },
      extendEnv: false,
      timeout: 120000,
    };
    await execa(process.execPath, args, options);
    const raw = await readFile(result, 'utf8');
    const preview = JSON.parse(raw);
    expect(preview.scope).toBe('whole-team-knowledge');
    expect(preview.providersInUse).toEqual(['openrouter']);
    expect(preview.content.members[0].files.map((file: { path: string }) => file.path)).toEqual([
      'SOUL.md',
    ]);
    expect(preview.content.members[0].omitted).toContainEqual({
      path: '.env',
      reason: 'credential-file',
    });
    expect(raw).not.toContain(staging);
    expect(raw).not.toContain('private-provider-key');
    expect(raw).not.toContain('source-private-channel-key');
    expect(preview.content.members[0].files[0]).not.toHaveProperty('source');
    expect(await readFile(path.join(state, 'openclaw.json'), 'utf8')).toBe(original);
    await expect(execa(process.execPath, args, options)).rejects.toThrow();
    expect(await readFile(result, 'utf8')).toBe(raw);
  }, 180000);
  it('rewrites nested JSON5 includes while retaining native merge directives and never reading live absolute link targets', async () => {
    await mkdir(path.join(state, 'parts'));
    await writeFile(
      path.join(state, 'openclaw.json'),
      `{$include:['./parts/base.json5'], agents: {$include:'./roles.json5'}}`,
    );
    await writeFile(
      path.join(state, 'parts/base.json5'),
      `{gateway:{mode:'local'}, /* authored */ tools:{profile:'coding'}}`,
    );
    await writeFile(path.join(state, 'roles.json5'), `{entries:{main:{name:'Coordinator'}}}`);
    const filename = await prepareCloneConfigView(input());
    const config = JSON.parse(await readFile(filename, 'utf8'));
    expect(config.$include).toHaveLength(1);
    expect(JSON.parse(await readFile(config.$include[0], 'utf8')).tools.profile).toBe('coding');
    expect(JSON.parse(await readFile(config.agents.$include, 'utf8')).entries.main.name).toBe(
      'Coordinator',
    );
    expect(await readFile(path.join(state, 'openclaw.json'), 'utf8')).toContain(
      './parts/base.json5',
    );
    await symlink('/home/ubuntu/.openclaw/roles.json5', path.join(state, 'alias.json5'));
    expect(
      await archivedClonePath({ ...input(), original: '/home/ubuntu/.openclaw/alias.json5' }),
    ).toEqual({
      source: path.join(state, 'roles.json5'),
      original: '/home/ubuntu/.openclaw/roles.json5',
    });
  });
  it('rejects include cycles, unbacked live paths and symlinked archive ancestors', async () => {
    await writeFile(path.join(state, 'openclaw.json'), `{$include:'./openclaw.json'}`);
    await expect(prepareCloneConfigView(input())).rejects.toThrow('cyclic');
    await writeFile(path.join(state, 'openclaw.json'), `{$include:'${root}/live.json'}`);
    await writeFile(path.join(root, 'live.json'), '{private:"must not read"}');
    await expect(prepareCloneConfigView(input())).rejects.toThrow('outside');
    await symlink(state, path.join(staging, 'alias'));
    await expect(
      archivedClonePath({
        ...input(),
        original: '/home/ubuntu/.openclaw/openclaw.json',
        moves: [
          { source: path.join(staging, 'alias/state'), destination: '/home/ubuntu/.openclaw' },
        ],
      }),
    ).rejects.toThrow('linked ancestor');
  });
  it('uses the real public native reader for modular source settings without executing source secrets or loading source env', async () => {
    const executed = path.join(root, 'must-not-execute');
    await writeFile(
      path.join(state, 'openclaw.json'),
      JSON.stringify({
        $include: './base.json5',
        secrets: {
          providers: {
            dangerous: { source: 'exec', command: '/bin/sh', args: ['-c', `touch ${executed}`] },
            file: { source: 'file', path: '/home/ubuntu/.openclaw/alias.json' },
          },
        },
        env: { shellEnv: { enabled: true } },
      }),
    );
    await writeFile(
      path.join(state, 'base.json5'),
      `{agents:{ownership:'explicit',entries:{main:{name:'Coordinator',model:'openrouter/example'}}},tools:{profile:'coding'}}`,
    );
    await writeFile(path.join(state, '.env'), 'SECRET=source-private-value\n');
    await writeFile(path.join(state, 'reference.json'), 'source-private-value');
    await symlink('/home/ubuntu/.openclaw/reference.json', path.join(state, 'alias.json'));
    const policy = await readCloneSourcePolicy({ ...input(), members, nativePackageJson });
    expect(policy.agents).toEqual([
      { id: 'main', name: 'Coordinator', model: { primary: 'openrouter/example' } },
    ]);
    expect(policy.tools).toEqual({ profile: 'coding' });
    expect(policy.credentialPaths).toEqual([
      '/home/ubuntu/.openclaw/alias.json',
      '/home/ubuntu/.openclaw/reference.json',
    ]);
    expect(JSON.stringify(policy)).not.toContain('source-private-value');
    await expect(access(executed)).rejects.toThrow();
  }, 180000);
});
