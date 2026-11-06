import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planCloneContent } from '../../src/openclaw/clone-content.js';
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'claw-clone-content-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const members = [
  {
    id: 'main',
    workspace: '/home/ubuntu/personal',
    agentDir: '/home/ubuntu/personal/native-agent',
    model: 'openrouter/example',
  },
  {
    id: 'researcher',
    workspace: '/home/ubuntu/research',
    agentDir: '/home/ubuntu/.openclaw/agents/researcher/agent',
    model: 'openrouter/research',
  },
];
async function fixture(base = root) {
  const staging = path.join(base, 'staging');
  const personal = path.join(staging, 'payload/personal');
  const research = path.join(staging, 'payload/research');
  await mkdir(path.join(personal, 'memory'), { recursive: true });
  await mkdir(path.join(personal, 'skills/helper'), { recursive: true });
  await mkdir(path.join(personal, '.github'), { recursive: true });
  await mkdir(path.join(personal, 'native-agent'), { recursive: true });
  await mkdir(research, { recursive: true });
  for (const [name, value] of Object.entries({
    'SOUL.md': 'persona',
    'memory/project.md': 'remember this',
    'skills/helper/SKILL.md': 'skill',
    '.github/CODEOWNERS': '* team',
    '.gitignore': 'node_modules',
    '.env': 'SOURCE_CHANNEL_TOKEN=private',
    'auth-profiles.json': 'private',
    'memory.sqlite': 'opaque identity',
    'memory.sqlite-wal': 'opaque runtime sidecar',
    '.npmrc': 'registry-token',
    'BOOTSTRAP.md': 'pending source setup',
    'native-agent/retained.txt': 'opaque agent state',
  }))
    await writeFile(path.join(personal, name), value);
  await writeFile(path.join(research, 'AGENTS.md'), 'research role');
  return {
    stagingDirectory: staging,
    moves: [
      { source: personal, destination: members[0].workspace },
      { source: research, destination: members[1].workspace },
    ],
    members,
  };
}
describe('independent clone content selection', () => {
  it('preserves the whole role roster, knowledge, skills and ordinary hidden project files while excluding machine identity', async () => {
    const plan = await planCloneContent(await fixture());
    expect(plan.members.map((member) => member.id)).toEqual(['main', 'researcher']);
    expect(plan.members[0].model).toBe('openrouter/example');
    expect(plan.members[0].files.map((file) => file.path)).toEqual([
      '.github/CODEOWNERS',
      '.gitignore',
      'SOUL.md',
      'memory/project.md',
      'skills/helper/SKILL.md',
    ]);
    expect(plan.members[0].omitted).toEqual(
      expect.arrayContaining([
        { path: '.env', reason: 'credential-file' },
        { path: 'auth-profiles.json', reason: 'credential-file' },
        { path: 'memory.sqlite', reason: 'runtime-state' },
        { path: 'memory.sqlite-wal', reason: 'runtime-state' },
        { path: '.npmrc', reason: 'credential-file' },
        { path: 'native-agent', reason: 'native-agent-state' },
      ]),
    );
    expect(plan.members[0].workspace).toBe('/home/ubuntu/.openclaw/workspaces/main');
    expect(plan.members[0].agentDir).toBe('/home/ubuntu/.openclaw/agents/main/agent');
    expect(plan.members[0].files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });
  it('never follows workspace links or copies hard-linked credential content', async () => {
    const input = await fixture();
    const personal = input.moves[0].source;
    await writeFile(path.join(root, 'outside-private'), 'secret');
    await symlink(path.join(root, 'outside-private'), path.join(personal, 'readme-link'));
    await link(path.join(root, 'outside-private'), path.join(personal, 'hard-copy'));
    const plan = await planCloneContent(input);
    expect(plan.members[0].omitted).toEqual(
      expect.arrayContaining([
        { path: 'readme-link', reason: 'linked-content' },
        { path: 'hard-copy', reason: 'linked-content' },
      ]),
    );
  });
  it('binds content and target roles independently of the extraction machine and detects content changes', async () => {
    const input = await fixture();
    const first = await planCloneContent(input);
    const other = path.join(root, 'other');
    await mkdir(other);
    await cp(input.stagingDirectory, path.join(other, 'staging'), { recursive: true });
    const moved = {
      ...input,
      stagingDirectory: path.join(other, 'staging'),
      moves: input.moves.map((move) => ({ ...move, source: move.source.replace(root, other) })),
    };
    expect((await planCloneContent(moved)).digest).toBe(first.digest);
    await writeFile(path.join(input.moves[0].source, 'SOUL.md'), 'different persona');
    expect((await planCloneContent(input)).digest).not.toBe(first.digest);
  });
  it('refuses ambiguous ownership, unknown payload paths and linked workspace ancestors', async () => {
    const input = await fixture();
    await expect(
      planCloneContent({
        ...input,
        members: [members[0], { ...members[1], workspace: members[0].workspace }],
      }),
    ).rejects.toThrow('overlapping');
    await expect(planCloneContent({ ...input, moves: [] })).rejects.toThrow('does not contain');
    await symlink(input.moves[0].source, path.join(input.stagingDirectory, 'alias'));
    await expect(
      planCloneContent({
        ...input,
        moves: [
          { ...input.moves[0], source: path.join(input.stagingDirectory, 'alias') },
          input.moves[1],
        ],
      }),
    ).rejects.toThrow('link');
  });
});
