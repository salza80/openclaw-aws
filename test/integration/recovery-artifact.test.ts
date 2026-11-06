import { describe, expect, it, vi } from 'vitest';
import { uploadRecoveryArtifact } from '../../src/aws/recovery-artifact.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
import { localS3 } from '../helpers/s3-server.js';

describe('packaged recovery worker delivery', () => {
  it('uploads versioned content-addressed artifacts, adopts identical retries and rejects corruption', async () => {
    const server = await localS3();
    vi.stubEnv('AWS_ENDPOINT_URL_S3', server.endpoint);
    const target = {
      ...testTarget,
      region: 'eu-central-1',
      credentials: async () => ({
        accessKeyId: 'FIXTUREKEYOPERATOR',
        secretAccessKey: 'fixture-secret',
      }),
    };
    try {
      const first = await uploadRecoveryArtifact(target, {
        bucket: 'private-backups',
        prefix: 'vault/main',
      });
      expect(first.files).toHaveLength(9);
      expect(first.files.map((file) => file.name)).toContain('worker.js');
      expect(first.files.map((file) => file.name)).toContain('restore-worker.js');
      expect(first.files.every((file) => file.versionId && file.key.includes(first.digest))).toBe(
        true,
      );
      const second = await uploadRecoveryArtifact(target, {
        bucket: 'private-backups',
        prefix: 'vault/main',
      });
      expect(second).toEqual(first);
      expect([...server.objects.values()].every((versions) => versions.length === 1)).toBe(true);
      server.objects.get(first.files[0].key)![0].body = Buffer.from('corrupt artifact');
      await expect(
        uploadRecoveryArtifact(target, { bucket: 'private-backups', prefix: 'vault/main' }),
      ).rejects.toThrow('exact-version readback');
    } finally {
      vi.unstubAllEnvs();
      await server.close();
    }
  }, 30000);
});
