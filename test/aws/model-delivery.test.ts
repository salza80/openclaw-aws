import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import {
  createModelArtifact,
  pinModelArtifact,
  modelArtifactFilenames,
} from '../../src/aws/model-artifact.js';
import { modelRemoteCommand, bedrockRemoteCommand } from '../../src/aws/model-delivery.js';
import { bedrockJob } from '../helpers/bedrock-operation.js';
import { modelJob } from '../helpers/model-operation.js';
describe('private Ubuntu model dispatch', () => {
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
