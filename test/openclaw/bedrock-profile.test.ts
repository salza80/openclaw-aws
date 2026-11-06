import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  assertBedrockRoleInputs,
  bedrockRoleProfile,
  prepareBedrockRoleProfile,
} from '../../src/openclaw/bedrock-profile.js';
const roots: string[] = [];
const home = async () => {
  const value = await realpath(await mkdtemp(path.join(tmpdir(), 'bedrock-role-profile-')));
  roots.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});
describe('private Bedrock instance-role environment', () => {
  it('creates an idempotent credential-free profile and additive service environment without editing user AWS config', async () => {
    const directory = await home();
    await mkdir(path.join(directory, '.aws'));
    const userConfig = '[default]\naws_access_key_id = fixture-user-key\n';
    await writeFile(path.join(directory, '.aws/config'), userConfig);
    const plan = await prepareBedrockRoleProfile(directory, 'eu-central-1', {
      serviceEnvironment: true,
    });
    expect(plan.contents).toBe('[profile openclaw-instance-role]\nregion = eu-central-1\n');
    expect(await readFile(plan.filename, 'utf8')).toBe(plan.contents);
    expect((await stat(plan.filename)).mode & 0o777).toBe(0o600);
    expect((await stat(plan.serviceFilename)).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(directory, '.aws/config'), 'utf8')).toBe(userConfig);
    expect(plan.serviceContents).toContain('UnsetEnvironment=AWS_ACCESS_KEY_ID');
    expect(plan.serviceContents).not.toContain('fixture-user-key');
    expect(plan.environment.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null');
    expect(
      await prepareBedrockRoleProfile(directory, 'eu-central-1', { serviceEnvironment: true }),
    ).toEqual(plan);
  });
  it('refuses foreign files, links and region changes instead of overwriting them', async () => {
    const directory = await home();
    const plan = await prepareBedrockRoleProfile(directory, 'eu-central-1');
    await expect(prepareBedrockRoleProfile(directory, 'us-east-1')).rejects.toThrow(
      /overwrite refused/,
    );
    await writeFile(plan.filename, 'foreign credential config');
    await expect(prepareBedrockRoleProfile(directory, 'eu-central-1')).rejects.toThrow(
      /overwrite refused/,
    );
    await rm(plan.filename);
    const foreign = path.join(directory, 'foreign');
    await writeFile(foreign, 'leave unchanged');
    await symlink(foreign, plan.filename);
    await expect(prepareBedrockRoleProfile(directory, 'eu-central-1')).rejects.toThrow();
    expect(await readFile(foreign, 'utf8')).toBe('leave unchanged');
    await rm(plan.filename);
    await execa('mkfifo', [plan.filename]);
    await expect(prepareBedrockRoleProfile(directory, 'eu-central-1')).rejects.toThrow(
      /overwrite refused/,
    );
  });
  it('escapes systemd specifiers and quotes while rejecting unsafe canonical roots', () => {
    const plan = bedrockRoleProfile('/tmp/host % with "quotes"', 'eu-central-1');
    expect(plan.serviceContents).toContain('%%');
    expect(plan.serviceContents).toContain('\\"quotes\\"');
    expect(() => bedrockRoleProfile('/tmp/host/../other', 'eu-central-1')).toThrow(/canonical/);
    expect(() => bedrockRoleProfile('/tmp/host\ninjected', 'eu-central-1')).toThrow(/canonical/);
    expect(() => bedrockRoleProfile('/tmp/host', 'eu-central-1\nother')).toThrow(/canonical/);
  });
  it('refuses saved foreign AWS credentials/endpoints using names-only diagnostics, while preserving direct provider credentials', () => {
    const plan = bedrockRoleProfile('/home/ubuntu', 'eu-central-1');
    expect(() =>
      assertBedrockRoleInputs('/home/ubuntu', 'eu-central-1', {
        ...plan.environment,
        OPENROUTER_API_KEY: 'fixture-openrouter',
      }),
    ).not.toThrow();
    for (const input of [
      { AWS_BEARER_TOKEN_BEDROCK: 'fixture-private-value' },
      { AWS_BEDROCK_SKIP_AUTH: 'true' },
      { AWS_ACCESS_KEY_ID: { source: 'env', provider: 'default', id: 'PRIVATE' } },
      { AWS_CONFIG_FILE: '/foreign/private-file' },
      { AWS_PROFILE: 'operator-profile' },
    ]) {
      try {
        assertBedrockRoleInputs('/home/ubuntu', 'eu-central-1', input);
        throw Error('expected rejection');
      } catch (error) {
        expect(String(error)).toContain(Object.keys(input)[0]);
        expect(String(error)).not.toContain('fixture-private-value');
        expect(String(error)).not.toContain('/foreign/private-file');
        expect(String(error)).not.toContain('operator-profile');
      }
    }
  });
  it('resolves the real SDK default chain from a region-only profile to IMDS and satisfies native catalog auth without persisting credentials', async () => {
    const directory = await home();
    const plan = await prepareBedrockRoleProfile(directory, 'eu-central-1');
    let reads = 0;
    const server = createServer((request, response) => {
      if (request.method === 'PUT' && request.url === '/latest/api/token') {
        response.end('fixture-imds-v2');
        return;
      }
      if (request.headers['x-aws-ec2-metadata-token'] !== 'fixture-imds-v2') {
        response.writeHead(401);
        response.end();
        return;
      }
      if (request.url === '/latest/meta-data/iam/security-credentials/') {
        response.end('fixture-role');
        return;
      }
      if (request.url === '/latest/meta-data/iam/security-credentials/fixture-role') {
        reads++;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            Code: 'Success',
            AccessKeyId: 'FIXTUREONLY',
            SecretAccessKey: 'fixture-secret',
            Token: 'fixture-session',
            Expiration: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No IMDS fixture');
      const repository = fileURLToPath(new URL('../../', import.meta.url));
      const script = `
        import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
        const require=createRequire(${JSON.stringify(path.join(repository, 'package.json'))});
        const nativeRequire=createRequire(${JSON.stringify(path.join(repository, 'node_modules/openclaw/package.json'))});
        const {defaultProvider}=require('@aws-sdk/credential-provider-node');
        const {getEnvApiKey}=await import(pathToFileURL(nativeRequire.resolve('@openclaw/ai/internal/runtime')).href);
        const credentials=await defaultProvider()();
        console.log(JSON.stringify({fromFixtureRole:credentials.accessKeyId==='FIXTUREONLY',nativeAuthVisible:Boolean(getEnvApiKey('amazon-bedrock'))}));`;
      const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
        env: {
          HOME: directory,
          PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
          ...plan.environment,
          AWS_EC2_METADATA_SERVICE_ENDPOINT: `http://127.0.0.1:${address.port}`,
        },
        extendEnv: false,
        timeout: 15000,
      });
      expect(JSON.parse(result.stdout)).toEqual({ fromFixtureRole: true, nativeAuthVisible: true });
      expect(reads).toBe(1);
      expect(await readFile(plan.filename, 'utf8')).toBe(plan.contents);
      expect(plan.contents).not.toContain('FIXTUREONLY');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
