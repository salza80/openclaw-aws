import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let child: ChildProcess | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe('production local console launch', () => {
  it('serves bundled assets and empty/reconnect states without any AWS host or local configuration', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'openclaw-ui-launch-'));
    const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
    child = spawn(process.execPath, [cli, 'ui', '--no-open'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pairing = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Local console launch timed out')), 15000);
      child!.on('error', reject);
      child!.stdout!.on('data', (chunk) => {
        output += chunk.toString();
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/#pair=[a-f0-9]{64}/)?.[0];
        if (url) {
          clearTimeout(timeout);
          resolve(url);
        }
      });
      child!.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('Console exited before pairing'));
      });
    });
    const url = new URL(pairing),
      origin = url.origin;
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    const html = await page.text();
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    const stylesheet = /href="([^"]+\.css)"/.exec(html)?.[1];
    expect(script).toMatch(/^\/assets\//);
    expect(stylesheet).toMatch(/^\/assets\//);
    expect((await fetch(new URL(script!, origin))).status).toBe(200);
    expect((await fetch(new URL(stylesheet!, origin))).status).toBe(200);
    expect((await fetch(origin + '/api/state')).status).toBe(401);
    const paired = await fetch(origin + '/api/session', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-openclaw-ui': '1' },
      body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get('pair') }),
    });
    expect(paired.status).toBe(200);
    expect(paired.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      expect(await (await fetch(origin + '/api/state', { headers: { cookie } })).json()).toEqual({
        deployments: [],
        jobs: [],
      });
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect((await exited)[0]).toBe(0);
  }, 30000);
});
