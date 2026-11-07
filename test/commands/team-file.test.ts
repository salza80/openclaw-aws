import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../src/cli/utils/aws-clients.js', () => ({
  createSsmClient: () => ({ send: mocks.send, destroy() {} }),
}));
import { readTeamFile, teamCredentials } from '../../src/cli/utils/team-file.js';
import { parseTeamDefinition } from '../../src/openclaw/team-definition.js';
let directory: string;
const input = {
  schemaVersion: 1,
  topology: 'single-host',
  coordinator: 'lead',
  members: [
    { id: 'lead', role: 'Coordinator', instructions: 'Coordinate.' },
    { id: 'researcher', role: 'Researcher', instructions: 'Research.' },
  ],
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'team-file-'));
  vi.resetAllMocks();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('team definition intake and private credential references', () => {
  it('reads strict YAML and JSON and refuses duplicate keys or plaintext key fields', async () => {
    const file = path.join(directory, 'team.yaml');
    await writeFile(file, JSON.stringify(input));
    expect((await readTeamFile(file)).coordinator).toBe('lead');
    await writeFile(file, `schemaVersion: 1\nschemaVersion: 1\n`);
    await expect(readTeamFile(file)).rejects.toThrow('Invalid team YAML');
    await writeFile(file, JSON.stringify({ ...input, apiKey: 'plaintext' }));
    await expect(readTeamFile(file)).rejects.toThrow('credential references');
  });
  it('binds an explicitly selected SSM key version without confusing the returned base name', async () => {
    const definition = parseTeamDefinition({
      ...input,
      credentials: [
        { provider: 'openrouter-api-key', kind: 'ssm', reference: '/shared/router-key:4' },
      ],
    });
    mocks.send.mockResolvedValue({
      Parameter: {
        Name: '/shared/router-key',
        Type: 'SecureString',
        Version: 4,
        Value: 'private-fixture-key',
      },
    });
    await expect(teamCredentials(definition, 'eu-central-1')).resolves.toEqual({
      'openrouter-api-key': 'private-fixture-key',
    });
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      Name: '/shared/router-key:4',
      WithDecryption: true,
    });
    mocks.send.mockResolvedValue({
      Parameter: {
        Name: '/shared/router-key',
        Type: 'SecureString',
        Version: 5,
        Value: 'private-fixture-key',
      },
    });
    await expect(teamCredentials(definition, 'eu-central-1')).rejects.toThrow(
      'missing or unsupported',
    );
  });
});
