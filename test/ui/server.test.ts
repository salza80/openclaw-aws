import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/cli/utils/config.js', () => ({ getConfigRoot: () => paths.root }));
import { createUiApp } from '../../src/ui/server.js';
import { fixtureBackend } from '../helpers/ui.js';
const origin = 'http://127.0.0.1:19445';
const code = 'a'.repeat(64);
let ui: Awaited<ReturnType<typeof createUiApp>>;
let backend: ReturnType<typeof fixtureBackend>;
const headers = {
  host: '127.0.0.1:19445',
  origin,
  'x-openclaw-ui': '1',
  'content-type': 'application/json',
};
beforeEach(async () => {
  paths.root = await mkdtemp(path.join(tmpdir(), 'openclaw-ui-api-'));
  await writeFile(path.join(paths.root, 'index.html'), '<!doctype html><title>Local UI</title>');
  backend = fixtureBackend();
  ui = await createUiApp(backend, { origin, bootstrapCode: code, assetsDirectory: paths.root });
});
afterEach(async () => {
  await ui.app.close();
  await rm(paths.root, { recursive: true, force: true });
});
async function pair() {
  const response = await ui.app.inject({
    method: 'POST',
    url: '/api/session',
    headers,
    payload: { code },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0];
}
describe('local console HTTP boundary', () => {
  it('returns a slow native preview over a real socket without losing its review', async () => {
    const prepare = backend.prepare;
    vi.spyOn(backend, 'prepare').mockImplementation(async (...args) => {
      await delay(31000);
      return prepare(...args);
    });
    const address = await ui.app.listen({ host: '127.0.0.1', port: 0 });
    ui.setOrigin(address);
    const requestHeaders = {
      origin: address,
      'x-openclaw-ui': '1',
      'content-type': 'application/json',
    };
    const session = await fetch(`${address}/api/session`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ code }),
    });
    expect(session.status).toBe(200);
    const response = await fetch(`${address}/api/plans`, {
      method: 'POST',
      headers: {
        ...requestHeaders,
        cookie: session.headers.get('set-cookie')!.split(';')[0],
      },
      body: JSON.stringify({ action: 'stop', name: 'alpha' }),
    }).catch((error: unknown) => error);
    // Even the old disconnected request could finish preparing a hidden review.
    // Drain that preparation before cleanup and assert its actual HTTP delivery.
    await vi.waitFor(async () => expect(await ui.jobs.list()).toHaveLength(1), {
      timeout: 3000,
    });
    expect(response).toBeInstanceOf(Response);
    const delivered = response as Response;
    expect(delivered.status).toBe(200);
    const job = await delivered.json();
    expect(job.phase).toBe('preview');
    expect((await ui.jobs.get(job.id)).id).toBe(job.id);
  }, 40000);
  it('pairs once using an HttpOnly cookie and requires the exact local host/origin', async () => {
    expect((await ui.app.inject({ url: '/api/state', headers })).statusCode).toBe(401);
    const cookie = await pair();
    expect(cookie).not.toContain(code);
    expect(
      (await ui.app.inject({ method: 'POST', url: '/api/session', headers, payload: { code } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await ui.app.inject({ url: '/api/state', headers: { ...headers, cookie } })).json(),
    ).toEqual({ deployments: [], jobs: [] });
    expect(
      (
        await ui.app.inject({
          url: '/api/state',
          headers: { ...headers, cookie, host: 'evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ui.app.inject({
          url: '/api/state',
          headers: { ...headers, cookie, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ui.app.inject({
          method: 'POST',
          url: '/api/plans',
          headers: { ...headers, cookie, 'x-openclaw-ui': '' },
          payload: { action: 'stop', name: 'alpha' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects raw credential fields and nonempty apply bodies before backend effects', async () => {
    const cookie = await pair();
    const prepare = vi.spyOn(backend, 'prepare');
    expect(
      (
        await ui.app.inject({
          method: 'POST',
          url: '/api/plans',
          headers: { ...headers, cookie },
          payload: {
            action: 'create',
            name: 'alpha',
            region: 'eu-central-1',
            provider: 'openrouter-api-key',
            apiKey: 'DO-NOT-LOG',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    const preview = await ui.app.inject({
      method: 'POST',
      url: '/api/plans',
      headers: { ...headers, cookie },
      payload: { action: 'stop', name: 'alpha' },
    });
    const id = preview.json().id;
    expect(
      (
        await ui.app.inject({
          method: 'POST',
          url: `/api/plans/${id}/apply`,
          headers: { ...headers, cookie },
          payload: { token: 'DO-NOT-LOG' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await ui.jobs.get(id)).phase).toBe('preview');
  });
  it('cannot bypass authentication with encoded paths, query strings or GET mutation routes', async () => {
    const prepare = vi.spyOn(backend, 'prepare');
    for (const url of ['/api/%73tate', '/%61pi/state', '/api/state?x=1']) {
      const response = await ui.app.inject({ url, headers });
      expect([401, 404]).toContain(response.statusCode);
    }
    expect((await ui.app.inject({ url: '/api/plans', headers })).statusCode).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('keeps HTTP progress independent of AWS observations and rejects credential-bearing native URLs', async () => {
    const cookie = await pair();
    const deployments = vi.spyOn(backend, 'deployments');
    expect(
      (await ui.app.inject({ url: '/api/jobs', headers: { ...headers, cookie } })).statusCode,
    ).toBe(200);
    expect(deployments).not.toHaveBeenCalled();
    backend.openNative = async () => ({ publicUrl: 'http://localhost:19444/#token=SECRET' });
    const result = await ui.app.inject({
      method: 'POST',
      url: '/api/native/alpha',
      headers: { ...headers, cookie },
      payload: {},
    });
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('SECRET');
    const page = await ui.app.inject({ url: '/', headers });
    expect(page.body).toContain('Local UI');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
  });
});
