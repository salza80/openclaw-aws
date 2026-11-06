import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planCloneContent, cloneContentDigest } from '../../src/openclaw/clone-content.js';
import { installCloneWorkspaces } from '../../src/openclaw/clone-workspaces.js';
let home: string;
const operationId = '11111111-1111-1111-1111-111111111111';
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'claw-clone-install-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const stagingDirectory = path.join(home, 'staging');
  const workspace = path.join(stagingDirectory, 'workspace');
  const work = path.join(home, '.openclaw-aws/jobs', operationId);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(path.join(home, '.openclaw'), { mode: 0o700 });
  await writeFile(path.join(workspace, 'SOUL.md'), 'retained persona');
  const plan = await planCloneContent({
    stagingDirectory,
    targetHome: home,
    members: [
      {
        id: 'main',
        workspace: '/home/ubuntu/workspace',
        agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
      },
    ],
    moves: [{ source: workspace, destination: '/home/ubuntu/workspace' }],
  });
  return { home, operationId, plan, journal: path.join(work, 'workspaces.json') };
}
describe('owned fresh clone workspace installation', () => {
  it('copies privately into new workspace ownership, preserves source data and adopts identical retries', async () => {
    const input = await fixture();
    expect(await installCloneWorkspaces(input)).toEqual({ members: 1, files: 1 });
    const destination = path.join(input.plan.members[0].workspace, 'SOUL.md');
    expect(await readFile(destination, 'utf8')).toBe('retained persona');
    expect((await lstat(destination)).mode & 0o077).toBe(0);
    expect(await readFile(input.plan.members[0].files[0].source, 'utf8')).toBe('retained persona');
    expect(await installCloneWorkspaces(input)).toEqual({ members: 1, files: 1 });
  });
  it('recovers a publication interrupted before removing its private incoming link', async () => {
    const input = await fixture();
    await installCloneWorkspaces(input);
    const destination = path.join(input.plan.members[0].workspace, 'SOUL.md');
    const incoming = path.join(
      path.dirname(input.journal),
      `workspace-${input.plan.members[0].files[0].sha256}.part`,
    );
    await link(destination, incoming);
    expect((await lstat(destination)).nlink).toBe(2);
    await installCloneWorkspaces(input);
    expect((await lstat(destination)).nlink).toBe(1);
    await expect(lstat(incoming)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses existing or modified target content without overwriting it', async () => {
    const input = await fixture();
    await mkdir(input.plan.members[0].workspace, { recursive: true });
    await expect(installCloneWorkspaces(input)).rejects.toThrow('already exists');
    await rm(input.plan.members[0].workspace, { recursive: true });
    await installCloneWorkspaces(input);
    const destination = path.join(input.plan.members[0].workspace, 'SOUL.md');
    await writeFile(destination, 'operator change');
    await expect(installCloneWorkspaces(input)).rejects.toThrow('nothing was overwritten');
    expect(await readFile(destination, 'utf8')).toBe('operator change');
  });
  it('does not publish changed source bytes or accept a different content plan on retry', async () => {
    const input = await fixture();
    await writeFile(input.plan.members[0].files[0].source, 'different source');
    await expect(installCloneWorkspaces(input)).rejects.toThrow(/source changed|differs/);
    await expect(
      lstat(path.join(input.plan.members[0].workspace, 'SOUL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    input.plan.members[0].files[0].path = '../escape';
    input.plan.digest = cloneContentDigest(input.plan.members);
    await expect(installCloneWorkspaces(input)).rejects.toThrow('Invalid clone workspace');
  });
});
