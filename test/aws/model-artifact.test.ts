import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../src/aws/ssm.js', () => ({ executeSsm: mocks.execute }));
import {
  createModelArtifact,
  deliverModelArtifact,
  modelArtifactCommands,
  modelArtifactDirectory,
  modelArtifactFilenames,
  modelArtifactProbe,
  pinModelArtifact,
  parseModelArtifactPin,
} from '../../src/aws/model-artifact.js';
let home: string;
const files = () =>
  modelArtifactFilenames.map((name) => ({
    name,
    body:
      name === 'worker.mjs' ? randomBytes(48 * 1024) : Buffer.from(`License fixture for ${name}`),
  }));
beforeEach(async () => {
  vi.clearAllMocks();
  let probes = 0;
  mocks.execute.mockImplementation(async (_instance, _target, commands: string[]) => ({
    stdout:
      commands.length === 1 && commands[0].includes('"ready"')
        ? JSON.stringify({ ready: ++probes > 1 })
        : '',
    stderr: '',
    commandId: 'fixture',
  }));
  home = await mkdtemp(path.join(os.tmpdir(), 'model artifact '));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Exercise the actual generated Ubuntu shell publication without root access.
 * The only platform shims map this fixture owner's UID to root and supply GNU
 * stat/ln behavior on macOS. Hashing, gzip, file writes, links and bash are real. */
async function shellFixture() {
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  const node = (source: string) => `#!${process.execPath}\n${source}\n`;
  await writeFile(path.join(bin, 'id'), '#!/bin/sh\nprintf 0\n', { mode: 0o700 });
  await writeFile(
    path.join(bin, 'stat'),
    node(
      `const fs=require('node:fs'); const args=process.argv.slice(2); const s=fs.lstatSync(args.at(-1)); const owner=s.uid===process.getuid()?0:s.uid; const fields={'%u':owner,'%a':(s.mode&0o777).toString(8),'%h':s.nlink,'%s':s.size}; process.stdout.write(args[1].replace(/%[uahs]/g,k=>String(fields[k]))+'\\n');`,
    ),
    { mode: 0o700 },
  );
  await writeFile(
    path.join(bin, 'ln'),
    node(
      `const fs=require('node:fs'); const args=process.argv.slice(2).filter(x=>!x.startsWith('-')); try{fs.linkSync(args[0],args[1]);}catch{process.exitCode=1;}`,
    ),
    { mode: 0o700 },
  );
  await writeFile(
    path.join(bin, 'sha256sum'),
    node(
      `const fs=require('node:fs'),crypto=require('node:crypto'); for(const line of fs.readFileSync(0,'utf8').trimEnd().split('\\n')) { const match=/^([a-f0-9]{64})  (.*)$/.exec(line); if(!match || crypto.createHash('sha256').update(fs.readFileSync(match[2])).digest('hex')!==match[1]) process.exitCode=1; }`,
    ),
    { mode: 0o700 },
  );
  const root = path.join(home, 'root');
  const env = {
    HOME: home,
    BASH_ENV: '/dev/null',
    PATH: `${bin}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/sbin:/usr/bin:/bin`,
  };
  const run = (command: string) =>
    execa(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        command
          .replace('env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin ', '')
          .replaceAll('/var/lib/openclaw-aws', root),
      ],
      {
        env,
        extendEnv: false,
        timeout: 10000,
      },
    );
  return { root, run };
}
describe('integrity-pinned chunked SSM worker artifacts', () => {
  it('assembles byte-exact files using generated shell, safely adopts identical delivery and retains licensing', async () => {
    const source = files();
    const artifact = createModelArtifact(source);
    const fixture = await shellFixture();
    const commands = modelArtifactCommands(artifact);
    expect(
      JSON.parse((await fixture.run(modelArtifactProbe(pinModelArtifact(artifact)))).stdout),
    ).toEqual({ ready: false });
    expect(commands.length).toBeGreaterThan(6);
    for (const command of commands) {
      expect(Buffer.byteLength(command)).toBeLessThan(24000);
      expect(command).not.toContain('/home/ubuntu');
      await execa('bash', ['-n'], { input: command });
      await fixture.run(command);
    }
    const directory = modelArtifactDirectory(artifact.digest).replace(
      '/var/lib/openclaw-aws',
      fixture.root,
    );
    for (const file of source)
      expect(await readFile(path.join(directory, file.name))).toEqual(Buffer.from(file.body));
    expect(
      JSON.parse((await fixture.run(modelArtifactProbe(pinModelArtifact(artifact)))).stdout),
    ).toEqual({ ready: true });
    for (const command of commands) await fixture.run(command);
    for (const file of source)
      expect(await readFile(path.join(directory, file.name))).toEqual(Buffer.from(file.body));
  }, 30000);
  it('refuses corrupted chunks or final-file symlinks without overwriting the conflicting file or following the link', async () => {
    const artifact = createModelArtifact(files());
    const fixture = await shellFixture();
    const commands = modelArtifactCommands(artifact);
    await fixture.run(commands[0]);
    const directory = modelArtifactDirectory(artifact.digest).replace(
      '/var/lib/openclaw-aws',
      fixture.root,
    );
    const chunk = path.join(directory, 'chunk-0-0000');
    await writeFile(chunk, 'foreign');
    await expect(fixture.run(commands[0])).rejects.toThrow();
    expect(await readFile(chunk, 'utf8')).toBe('foreign');
    await rm(chunk);
    const outside = path.join(home, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(directory, 'worker.mjs'));
    for (const command of commands.slice(0, -4)) {
      // Stop at the worker publication, which refuses the preexisting link.
      if (command.includes('gzip --decompress')) {
        await expect(fixture.run(command)).rejects.toThrow();
        break;
      }
      await fixture.run(command);
    }
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(outside)).toEqual([]);
  }, 30000);
  it('refuses a substituted ancestor before creating files through it', async () => {
    const artifact = createModelArtifact(files());
    const fixture = await shellFixture();
    const outside = path.join(home, 'outside');
    await mkdir(outside);
    await symlink(outside, fixture.root);
    await expect(fixture.run(modelArtifactCommands(artifact)[0])).rejects.toThrow();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(outside)).toEqual([]);
  });
  it('rejects missing/duplicate/foreign filenames, altered manifests and modified compressed bytes before sending commands', () => {
    const source = files();
    expect(() => createModelArtifact(source.slice(1))).toThrow(/inventory/);
    expect(() => createModelArtifact([...source, source[0]])).toThrow(/inventory/);
    expect(() =>
      createModelArtifact(source.map((file, i) => (i ? file : { ...file, name: '../worker.mjs' }))),
    ).toThrow(/inventory/);
    const artifact = createModelArtifact(source);
    expect(() => modelArtifactCommands({ ...artifact, digest: '0'.repeat(64) })).toThrow(
      /identity/,
    );
    artifact.files[0].compressed[0] ^= 0xff;
    expect(() => modelArtifactCommands(artifact)).toThrow(/contents/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('uses ordered fail-fast bounded SSM batches and stops after failed delivery without launching native code', async () => {
    const artifact = createModelArtifact(files());
    const commands = modelArtifactCommands(artifact);
    const target = { region: 'eu-central-1' };
    const signal = AbortSignal.timeout(10000);
    await deliverModelArtifact('i-0123456789abcdef0', target, artifact, signal);
    const calls = mocks.execute.mock.calls;
    expect(calls).toHaveLength(Math.ceil(commands.length / 2) + 2);
    expect(calls.slice(1, -1).flatMap((call) => call[2].slice(1))).toEqual(commands);
    for (const call of calls.slice(1, -1)) {
      expect(call[0]).toBe('i-0123456789abcdef0');
      expect(call[1]).toBe(target);
      expect(call[2][0]).toBe('set -e');
      expect(Buffer.byteLength(JSON.stringify(call[2]))).toBeLessThan(60000);
      expect(call[3]).toEqual({ executionSeconds: 60, signal });
    }
    mocks.execute.mockReset().mockRejectedValue(Error('delivery failed'));
    await expect(deliverModelArtifact('i-0123456789abcdef0', target, artifact)).rejects.toThrow(
      /delivery failed/,
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('reuses only fully verified installed code and rejects corrupted pin metadata or invalid probe responses', async () => {
    const artifact = createModelArtifact(files());
    const pin = pinModelArtifact(artifact);
    expect(
      parseModelArtifactPin({
        files: pin.files.map((file) => ({
          size: file.size,
          compressedSha256: file.compressedSha256,
          name: file.name,
          sha256: file.sha256,
        })),
        digest: pin.digest,
      }),
    ).toEqual(pin);
    expect(() =>
      parseModelArtifactPin({
        ...pin,
        files: pin.files.map((file, index) => (index ? file : { ...file, sha256: '0'.repeat(64) })),
      }),
    ).toThrow(/digest changed/);
    mocks.execute.mockResolvedValue({ stdout: '{"ready":true}', stderr: '', commandId: 'probe' });
    await deliverModelArtifact('i-0123456789abcdef0', { region: 'eu-central-1' }, artifact);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    mocks.execute.mockResolvedValue({ stdout: '{"ready":true,"privateAuth":"must-not-publish"}' });
    await expect(
      deliverModelArtifact('i-0123456789abcdef0', { region: 'eu-central-1' }, artifact),
    ).rejects.toThrow(/availability could not be verified/);
  });
});
