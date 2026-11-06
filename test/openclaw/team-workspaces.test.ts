import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, link, lstat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseTeamDefinition, teamMembers } from '../../src/openclaw/team-definition.js';
import {
  inspectTeamInstructions,
  writeTeamInstructions,
  assertTeamInstructions,
} from '../../src/openclaw/team-workspaces.js';
const definition = parseTeamDefinition({
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Lead', instructions: 'Coordinate.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research.' },
  ],
});
const operationId = '22222222-2222-2222-2222-222222222222';
let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'team-workspaces-'));
  await mkdir(path.join(home, '.openclaw/workspace'), { recursive: true });
  await mkdir(path.join(home, '.openclaw/agents/main/agent'), { recursive: true });
  await writeFile(path.join(home, '.openclaw/workspace/AGENTS.md'), 'Fresh original\n');
});
afterEach(async () => rm(home, { recursive: true, force: true }));
const members = () =>
  teamMembers(definition, home, {
    id: 'main',
    workspace: path.join(home, '.openclaw/workspace'),
    agentDir: path.join(home, '.openclaw/agents/main/agent'),
  });
async function options() {
  const roster = members();
  return {
    home,
    operationId,
    definition,
    members: roster,
    existing: ['main'],
    pins: await inspectTeamInstructions(home, definition, roster, ['main']),
    beforeWrite: vi.fn(async () => {}),
  };
}
describe('owned team role instructions', () => {
  it('repairs an interrupted private staging write only with its preexisting intent proof', async () => {
    const plan = await options();
    const filename = path.join(
      home,
      '.openclaw/workspace',
      '.AGENTS.md.openclaw-team-' + operationId,
    );
    await writeFile(filename, 'partial staged bytes', { mode: 0o600 });
    await expect(writeTeamInstructions(plan)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(filename, 'utf8')).toBe('partial staged bytes');
    await writeTeamInstructions({ ...plan, beforeWrite: async () => true });
    await expect(assertTeamInstructions(home, definition, plan.members)).resolves.toBeUndefined();
  });
  it('publishes only the declared roots and recovers interrupted create-only hard-link publication', async () => {
    const plan = await options();
    await writeTeamInstructions(plan);
    const researcher = plan.members.find((m) => m.id === 'researcher')!;
    const filename = path.join(researcher.workspace, 'AGENTS.md');
    const incoming = path.join(researcher.workspace, '.AGENTS.md.openclaw-team-' + operationId);
    await link(filename, incoming);
    expect((await lstat(filename)).nlink).toBe(2);
    plan.beforeWrite.mockClear();
    await writeTeamInstructions(plan);
    expect((await lstat(filename)).nlink).toBe(1);
    expect(plan.beforeWrite).not.toHaveBeenCalled();
    await expect(assertTeamInstructions(home, definition, plan.members)).resolves.toBeUndefined();
  });
  it('refuses changed instruction bytes before publication without overwriting them', async () => {
    const plan = await options();
    const filename = path.join(home, '.openclaw/workspace/AGENTS.md');
    plan.beforeWrite.mockImplementationOnce(async () => {
      await writeFile(filename, 'Concurrent user edit\n');
    });
    await expect(writeTeamInstructions(plan)).rejects.toThrow('changed before publication');
    expect(await readFile(filename, 'utf8')).toBe('Concurrent user edit\n');
  });
  it('refuses undeclared existing agent data or a redirected workspace', async () => {
    const roster = members();
    const researcher = roster.find((m) => m.id === 'researcher')!;
    await mkdir(researcher.agentDir, { recursive: true });
    await writeFile(path.join(researcher.agentDir, 'native.sqlite'), 'unrelated native identity');
    await expect(inspectTeamInstructions(home, definition, roster, ['main'])).rejects.toThrow(
      'unrelated',
    );
    await rm(researcher.agentDir, { recursive: true });
    await mkdir(path.dirname(researcher.workspace), { recursive: true });
    await mkdir(path.join(home, 'outside'));
    await writeFile(path.join(home, 'outside/AGENTS.md'), 'Unrelated instructions');
    await symlink(path.join(home, 'outside'), researcher.workspace);
    await expect(inspectTeamInstructions(home, definition, roster, ['main'])).rejects.toThrow();
    expect(await readFile(path.join(home, 'outside/AGENTS.md'), 'utf8')).toBe(
      'Unrelated instructions',
    );
  });
});
