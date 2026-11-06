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
  await mkdir(view);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const input = () => ({
  configurationPath: '/home/ubuntu/.openclaw/openclaw.json',
  stagingDirectory: staging,
  moves: [{ source: state, destination: '/home/ubuntu/.openclaw' }],
  viewDirectory: view,
  parse: parser.parse,
});

describe('isolated archived clone configuration', () => {
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
