import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { UiJobs } from './jobs.js';
import { UiInputError, parseUiActionRequest, parseUiVault, uiName } from './input.js';
import { teamId } from '../openclaw/team-contract.js';
import { nativeModelScope } from '../openclaw/model-control.js';
import type { UiBackend } from './contracts.js';

const sameSecret = (actual: unknown, expected: string) =>
  typeof actual === 'string' &&
  /^[a-f0-9]{64}$/.test(actual) &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
/** Bind separately so tests can inject HTTP requests without AWS or a listener. */
export async function createUiApp(
  backend: UiBackend,
  options: {
    origin?: string;
    assetsDirectory?: string;
    bootstrapCode?: string;
  } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    keepAliveTimeout: 5000,
  });
  const jobs = new UiJobs(backend);
  const bootstrapCode = options.bootstrapCode ?? randomBytes(32).toString('hex');
  const createdAt = Date.now();
  let paired = false;
  const session = randomBytes(32).toString('hex');
  let origin = options.origin ?? 'http://127.0.0.1:0';
  const setOrigin = (input: string) => {
    const url = new URL(input);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.port === '0' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Local UI origin must be its owned loopback listener');
    origin = url.origin;
  };
  if (options.origin) setOrigin(options.origin);
  const cookieName = () => `openclaw-ui-${new URL(origin).port}`;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const host = new URL(origin).host;
    if (request.headers.host !== host)
      return reply.code(403).send({ error: 'Invalid local UI host' });
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const suppliedOrigin = request.headers.origin;
    if (suppliedOrigin !== undefined && suppliedOrigin !== origin)
      return reply.code(403).send({ error: 'Invalid local UI origin' });
    if (
      request.method !== 'GET' &&
      (suppliedOrigin !== origin ||
        request.headers['x-openclaw-ui'] !== '1' ||
        !request.headers['content-type']?.startsWith('application/json'))
    )
      return reply
        .code(403)
        .send({ error: 'Local UI mutations require the authenticated JSON client' });
    if (route === '/api/session' && request.method === 'POST') return;
    const value = request.headers.cookie
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(cookieName() + '='))
      ?.slice(cookieName().length + 1);
    if (!paired || !sameSecret(value, session) || Date.now() - createdAt > 8 * 60 * 60 * 1000)
      return reply.code(401).send({ error: 'Pair this local UI session from its CLI launch' });
  });
  app.post<{ Body: { code?: unknown } }>('/api/session', async (request, reply) => {
    if (
      paired ||
      Date.now() - createdAt > 10 * 60 * 1000 ||
      !sameSecret(request.body?.code, bootstrapCode) ||
      Object.keys(request.body ?? {}).some((key) => key !== 'code')
    )
      return reply
        .code(401)
        .send({ error: 'Local UI pairing is expired or invalid; relaunch the CLI UI' });
    paired = true;
    reply.header(
      'Set-Cookie',
      `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`,
    );
    return { paired: true };
  });
  app.get('/api/state', async () => ({
    deployments: await backend.deployments(),
    jobs: await jobs.list(),
  }));
  app.get('/api/jobs', async () => ({ jobs: await jobs.list() }));
  app.get<{ Querystring: { uri?: string; region?: string; profile?: string } }>(
    '/api/recovery',
    async (request) => ({ points: await backend.recovery(parseUiVault(request.query)) }),
  );
  app.get<{ Params: { name: string }; Querystring: { agent?: string } }>(
    '/api/models/:name',
    async (request) => {
      const name = uiName(request.params.name);
      if (request.query.agent !== undefined)
        nativeModelScope({ kind: 'agent', agentId: request.query.agent });
      return backend.models(name, request.query.agent);
    },
  );
  app.post('/api/plans', async (request) => jobs.preview(parseUiActionRequest(request.body)));
  const emptyBody = (body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      throw new UiInputError('This operation takes an empty JSON object');
  };
  app.post<{ Params: { id: string } }>('/api/plans/:id/apply', async (request) => {
    emptyBody(request.body);
    return jobs.apply(teamId(request.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/plans/:id/cancel', async (request) => {
    emptyBody(request.body);
    return jobs.cancel(teamId(request.params.id));
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) =>
    jobs.get(teamId(request.params.id)),
  );
  app.post<{ Params: { name: string } }>('/api/native/:name', async (request) => {
    emptyBody(request.body);
    const result = await backend.openNative(uiName(request.params.name));
    const url = new URL(result.publicUrl);
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Unsupported native UI handoff result');
    return { publicUrl: url.origin };
  });
  app.setErrorHandler((error, _request, reply) => {
    const invalid =
      error instanceof UiInputError ||
      error instanceof SyntaxError ||
      (typeof error === 'object' && error !== null && 'validation' in error);
    reply.code(invalid ? 400 : 409).send({
      error: invalid
        ? 'Invalid structured operation input'
        : 'Operation was not confirmed. Check AWS sign-in and inspect the original operation before retrying.',
    });
  });
  await app.register(staticFiles, {
    root: options.assetsDirectory ?? fileURLToPath(new URL('../ui-client/', import.meta.url)),
    index: ['index.html'],
    cacheControl: false,
  });
  app.addHook('onClose', async () => {
    await jobs.closePreviews();
    await jobs.drain();
    await backend.close();
  });
  return {
    app,
    jobs,
    bootstrapCode,
    setOrigin,
    get origin() {
      return origin;
    },
  };
}
