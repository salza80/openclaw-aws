import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import type { CloneJob } from './clone-contract.js';

/** IAM changes propagate asynchronously. Require actual denied source reads
 * before allowing an active agent to run under this role. Never log responses.
 */
export async function assertCloneSourceAccessRevoked(
  job: CloneJob,
  credentials: AwsCredentialIdentityProvider,
  signal?: AbortSignal,
) {
  const secret = new SecretsManagerClient({ region: job.backup.job.source.region, credentials });
  const s3 = new S3Client({ region: job.backup.job.settings.region, credentials });
  const denied = (error: unknown) =>
    error instanceof Error &&
    ['AccessDeniedException', 'AccessDenied', 'Forbidden', '403'].includes(error.name);
  try {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const request = {
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      };
      let keyDenied = false,
        archiveDenied = false;
      let keyUnknown = false,
        archiveUnknown = false;
      try {
        await secret.send(
          new GetSecretValueCommand({
            SecretId: job.backup.job.key.arn,
            VersionId: job.backup.job.key.versionId,
            VersionStage: job.backup.job.key.versionStage,
          }),
          request,
        );
      } catch (error) {
        keyDenied = denied(error);
        keyUnknown = !keyDenied;
      }
      if (keyUnknown) throw new Error('Source key-access revocation could not be verified');
      const location = `backups/${job.backup.job.namespace}/${job.backup.capture.capture.location.key}`;
      const pin = job.backup.capture.objects[location];
      if (!pin) throw new Error('Selected source archive has no immutable version');
      try {
        await s3.send(
          new HeadObjectCommand({
            Bucket: job.backup.job.settings.bucket,
            Key: `${job.backup.job.settings.prefix}/${location}`,
            VersionId: pin.versionId,
            ExpectedBucketOwner: job.target.account,
          }),
          request,
        );
      } catch (error) {
        archiveDenied = denied(error);
        archiveUnknown = !archiveDenied;
      }
      if (archiveUnknown) throw new Error('Source archive-access revocation could not be verified');
      if (keyDenied && archiveDenied) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      'Source backup/key access is still available; clone activation remains withheld',
    );
  } finally {
    secret.destroy();
    s3.destroy();
  }
}
