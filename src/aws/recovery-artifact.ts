import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { awsClientConfig, type AwsTarget } from './target.js';

export interface RecoveryArtifactFile {
  name: string;
  key: string;
  versionId: string;
  sha256: string;
}
export interface RecoveryArtifact {
  digest: string;
  files: RecoveryArtifactFile[];
}
const filenames = [
  'index.js',
  'worker.js',
  'package.json',
  'openclaw.plugin.json',
  'index.js.LEGAL.txt',
  'worker.js.LEGAL.txt',
  'THIRD-PARTY-LICENSES.txt',
];

/** Publish the self-contained transport/worker; hosts download exact checksummed versions. */
export async function uploadRecoveryArtifact(
  target: AwsTarget,
  location: { bucket: string; prefix: string },
): Promise<RecoveryArtifact> {
  const files = await Promise.all(
    filenames.map(async (name) => {
      const body = await readFile(
        new URL(`../../dist/native-plugins/aws-s3/${name}`, import.meta.url),
      );
      if (body.length > 8 * 1024 * 1024)
        throw new Error('Recovery artifact exceeds supported file size');
      return { name, body, sha256: createHash('sha256').update(body).digest('hex') };
    }),
  );
  const digest = createHash('sha256')
    .update(JSON.stringify(files.map(({ name, sha256 }) => [name, sha256])))
    .digest('hex');
  const client = new S3Client(awsClientConfig(target));
  const common = { Bucket: location.bucket, ExpectedBucketOwner: target.account };
  const published: RecoveryArtifactFile[] = [];
  try {
    for (const file of files) {
      const key = `${location.prefix}/_tools/${digest}/${file.name}`;
      const signal = AbortSignal.timeout(60000);
      let versionId: string | undefined;
      try {
        versionId = (
          await client.send(
            new PutObjectCommand({
              ...common,
              Key: key,
              Body: file.body,
              ContentLength: file.body.length,
              ChecksumSHA256: createHash('sha256').update(file.body).digest('base64'),
              IfNoneMatch: '*',
            }),
            { abortSignal: signal },
          )
        ).VersionId;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'PreconditionFailed') throw error;
      }
      const readback = await client.send(
        new GetObjectCommand({ ...common, Key: key, VersionId: versionId }),
        { abortSignal: signal },
      );
      try {
        if (
          !readback.VersionId ||
          readback.VersionId === 'null' ||
          (versionId && versionId !== readback.VersionId) ||
          readback.ContentLength !== file.body.length ||
          !Buffer.from(await readback.Body!.transformToByteArray()).equals(file.body)
        )
          throw new Error('Recovery artifact failed exact-version readback');
        published.push({
          name: file.name,
          key,
          versionId: readback.VersionId,
          sha256: file.sha256,
        });
      } finally {
        if (
          readback.Body &&
          'destroy' in readback.Body &&
          typeof readback.Body.destroy === 'function'
        )
          readback.Body.destroy();
      }
    }
    return { digest, files: published };
  } finally {
    client.destroy();
  }
}
