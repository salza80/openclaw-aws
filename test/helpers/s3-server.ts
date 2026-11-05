import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';

interface ObjectVersion {
  id: string;
  body: Buffer;
  deleted?: boolean;
}
const xml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Local AWS protocol fixture. It never forwards requests or uses real credentials. */
export async function localS3() {
  const objects = new Map<string, ObjectVersion[]>();
  const authorizations: string[] = [];
  let credentialReads = 0;
  const credentialKey = () => (authorizations.length ? 'FIXTUREKEYREFRESHED' : 'FIXTUREKEYINITIAL');
  const fail = (res: ServerResponse, code: string, status = 404) => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<Error><Code>${code}</Code><Message>Local test fixture</Message></Error>`);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/latest/api/token') {
      res.end('fixture-imds-v2-token');
      return;
    }
    if (url.pathname === '/latest/meta-data/iam/security-credentials/') {
      res.end('fixture-role');
      return;
    }
    if (url.pathname === '/latest/meta-data/iam/security-credentials/fixture-role') {
      credentialReads++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          Code: 'Success',
          AccessKeyId: credentialKey(),
          SecretAccessKey: 'fixture-secret-never-real',
          Token: 'fixture-token',
          Expiration: new Date(Date.now() + 120000).toISOString(),
        }),
      );
      return;
    }
    const auth = req.headers.authorization ?? '';
    authorizations.push(auth);
    if (
      !auth.includes('FIXTUREKEY') ||
      req.headers['x-amz-expected-bucket-owner'] !== '123456789012'
    ) {
      fail(res, 'AccessDenied', 403);
      return;
    }
    if (!url.pathname.startsWith('/private-backups/')) {
      fail(res, 'NoSuchBucket');
      return;
    }
    const key = decodeURIComponent(url.pathname.slice('/private-backups/'.length));
    const versions = objects.get(key) ?? [];
    const version = url.searchParams.get('versionId');
    const current = version ? versions.find((item) => item.id === version) : versions.at(-1);
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && current && !current.deleted) {
        fail(res, 'PreconditionFailed', 412);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const id = randomUUID();
      versions.push({ id, body });
      objects.set(key, versions);
      res.writeHead(200, { 'x-amz-version-id': id, etag: '"fixture-etag"' });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      if (version)
        objects.set(
          key,
          versions.filter((item) => item.id !== version),
        );
      else {
        versions.push({ id: randomUUID(), body: Buffer.alloc(0), deleted: true });
        objects.set(key, versions);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...objects.entries()].flatMap(([name, values]) => {
        const item = values.at(-1);
        return name.startsWith(prefix) && item && !item.deleted
          ? [
              `<Contents><Key>${xml(name)}</Key><Size>${item.body.length}</Size><LastModified>2026-11-05T00:00:00.000Z</LastModified></Contents>`,
            ]
          : [];
      });
      res.setHeader('content-type', 'application/xml');
      res.end(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${items.join('')}</ListBucketResult>`,
      );
      return;
    }
    if (!current || current.deleted) {
      fail(res, version ? 'NoSuchVersion' : 'NoSuchKey');
      return;
    }
    res.writeHead(200, {
      'content-length': current.body.length,
      'x-amz-version-id': current.id,
      'x-amz-checksum-sha256': createHash('sha256').update(current.body).digest('base64'),
    });
    res.end(req.method === 'HEAD' ? undefined : current.body);
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    authorizations,
    credentialReads: () => credentialReads,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
