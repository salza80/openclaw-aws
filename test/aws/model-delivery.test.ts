import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import {
  createModelArtifact,
  pinModelArtifact,
  modelArtifactFilenames,
} from '../../src/aws/model-artifact.js';
import {
  modelRemoteCommand,
  bedrockRemoteCommand,
  teamRemoteCommand,
} from '../../src/aws/model-delivery.js';
import { parseTeamJob } from '../../src/openclaw/team-contract.js';
import { parseTeamDefinition, teamMembers } from '../../src/openclaw/team-definition.js';
import { bedrockJob } from '../helpers/bedrock-operation.js';
import { modelJob } from '../helpers/model-operation.js';
describe('private Ubuntu model dispatch', () => {
  it('shares the three-file pinned transport for bounded team requests and refuses unsupported read recovery', async () => {
    const pin = pinModelArtifact(
      createModelArtifact(
        modelArtifactFilenames.map((name) => ({ name, body: Buffer.from(name) })),
      ),
    );
    const definition = parseTeamDefinition({
      schemaVersion: 1,
      topology: 'single-host',
      coordinator: 'main',
      members: Array.from({ length: 16 }, (_, index) => ({
        id: index === 0 ? 'main' : `member-${index}-${'x'.repeat(40)}`,
        role: 'Role ' + index,
        instructions: 'x'.repeat(180),
      })),
    });
    const members = teamMembers(definition, '/home/ubuntu', {
      id: 'main',
      workspace: '/home/ubuntu/.openclaw/workspace',
      agentDir: '/home/ubuntu/.openclaw/agents/main/agent',
    });
    const job = parseTeamJob({
      schemaVersion: 1,
      kind: 'native-team',
      operationId: modelJob.operationId,
      teamId: modelJob.operationId,
      target: modelJob.target,
      runtime: modelJob.runtime,
      bedrockRole: false,
      definition,
      action: {
        kind: 'configure',
        expectedHash: 'r'.repeat(2048),
        existingMembers: members,
        instructions: members.map((member) => ({ agentId: member.id, sha256: 'a'.repeat(64) })),
        reloadOff: false,
        allowRestart: false,
      },
    });
    const encoded = Buffer.from(JSON.stringify(job)).toString('base64');
    expect(encoded.length).toBeGreaterThan(16000);
    for (const mode of ['execute', 'inspect', 'resume', 'abort'] as const) {
      const command = teamRemoteCommand({ pin, job, mode });
      await execa('/bin/bash', ['--noprofile', '--norc', '-n'], { input: command });
      expect(command).toContain('--team-dispatch');
      expect(command).toContain(encoded);
      expect(command).toContain('env -i HOME=/home/ubuntu');
      expect(command).not.toContain('AWS_ACCESS_KEY_ID');
      expect(Buffer.byteLength(command)).toBeLessThan(60000);
    }
    expect(() =>
      teamRemoteCommand({ pin, job: { ...job, action: { kind: 'preview' } }, mode: 'resume' }),
    ).toThrow('Unsupported team');
  });
  it('delivers provider requests through the same root-pinned artifact and Ubuntu-only shared flock boundary', async () => {
    const pin = pinModelArtifact(
      createModelArtifact(
        modelArtifactFilenames.map((name) => ({ name, body: Buffer.from(name) })),
      ),
    );
    const command = bedrockRemoteCommand({ pin, job: bedrockJob, mode: 'execute' });
    await execa('/bin/bash', ['--noprofile', '--norc', '-n'], { input: command });
    expect(command).toContain('--bedrock-dispatch');
    expect(command).toContain('sudo -H -u ubuntu');
    expect(command).toContain('env -i HOME=/home/ubuntu');
    expect(command).not.toContain('AWS_ACCESS_KEY_ID');
    expect(Buffer.byteLength(command)).toBeLessThan(60000);
    const abort = bedrockRemoteCommand({ pin, job: bedrockJob, mode: 'abort' });
    await execa('/bin/bash', ['--noprofile', '--norc', '-n'], { input: abort });
    expect(abort).toContain("'abort'");
  });
  it('checks root-owned artifact pins before Ubuntu-only immutable request installation and clean native execution', async () => {
    const pin = pinModelArtifact(
      createModelArtifact(
        modelArtifactFilenames.map((name) => ({ name, body: Buffer.from(`fixture ${name}`) })),
      ),
    );
    const command = modelRemoteCommand({ pin, job: modelJob, mode: 'execute' });
    await execa('/bin/bash', ['--noprofile', '--norc', '-n'], { input: command });
    expect(command).toContain('sudo -H -u ubuntu');
    expect(command).toContain('/usr/bin/stat');
    expect(command).toContain('/usr/bin/sha256sum');
    expect(command).toContain(`model-artifacts/${pin.digest}/worker.mjs`);
    expect(command).toContain('--dispatch');
    expect(command).toContain('env -i HOME=/home/ubuntu');
    expect(command).not.toContain('mkdir');
    expect(command).not.toContain('AWS_ACCESS_KEY_ID');
    expect(command.indexOf('/usr/bin/sha256sum')).toBeLessThan(command.indexOf('--dispatch'));
    expect(Buffer.byteLength(command)).toBeLessThan(60000);
    const encoded = Buffer.from(JSON.stringify(modelJob)).toString('base64');
    expect(command).toContain(encoded);
    expect(() =>
      modelRemoteCommand({
        pin: { ...pin, digest: '0'.repeat(64) },
        job: modelJob,
        mode: 'execute',
      }),
    ).toThrow();
  });
});
