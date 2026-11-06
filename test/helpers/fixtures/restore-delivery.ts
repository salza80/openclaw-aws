import { createHash } from 'node:crypto';
import { recoveryArtifactFilenames } from '../../../src/aws/recovery-artifact.js';
import { parseRestoreJob } from '../../../src/openclaw/restore-contract.js';
import { restoreJobFixture } from './backup.js';
export function restoreDeliveryFixture() {
  const entries = recoveryArtifactFilenames.map((name) => ({
    name,
    sha256: createHash('sha256').update(name).digest('hex'),
  }));
  const digest = createHash('sha256')
    .update(JSON.stringify(entries.map(({ name, sha256 }) => [name, sha256])))
    .digest('hex');
  const job = parseRestoreJob({
    ...structuredClone(restoreJobFixture),
    pluginDirectory: `/home/ubuntu/.openclaw-aws/plugins/${digest}`,
  });
  const prefix = job.backup.job.settings.prefix;
  return {
    job,
    artifact: {
      digest,
      files: entries.map((file, index) => ({
        ...file,
        key: `${prefix}/_tools/${digest}/${file.name}`,
        versionId: `artifact-version-${index}`,
      })),
    },
    request: {
      key: `${prefix}/_operations/restore/${job.bootstrap.operationId}/request.json`,
      versionId: 'request-version',
      sha256: createHash('sha256').update(JSON.stringify(job)).digest('hex'),
    },
  };
}
