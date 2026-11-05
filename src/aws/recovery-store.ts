import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { awsClientConfig, type AwsTarget } from './target.js';

const MAX_METADATA_BYTES = 128 * 1024;
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('base64');
export interface VaultLocation {
  bucket: string;
  prefix: string;
}
export interface RecoveryMetadata {
  value: unknown;
  versionId: string;
  checksumSHA256: string;
}
function relativeKey(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid recovery-store key');
  return value;
}
export function parseVaultUri(uri: string): VaultLocation {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+?)\/?$/.exec(uri);
  if (
    !match ||
    match[1].includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(match[1]) ||
    /[%?#]/.test(match[2])
  )
    throw new Error('Expected s3://bucket/nonempty-vault-prefix');
  const prefix = relativeKey(match[2]);
  if (Buffer.byteLength(prefix, 'utf8') > 512)
    throw new Error('Recovery vault prefix exceeds 512 bytes');
  return { bucket: match[1], prefix };
}
function objectVersion(value: string | undefined): string {
  if (
    !value ||
    value === 'null' ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error('Recovery metadata requires an enabled, versioned S3 bucket');
  return value;
}
async function readBody(body: unknown, size?: number): Promise<Buffer> {
  if (
    !body ||
    typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function' ||
    (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_METADATA_BYTES))
  )
    throw new Error('Invalid or oversized recovery metadata');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid recovery metadata byte stream');
    length += chunk.byteLength;
    if (length > MAX_METADATA_BYTES) throw new Error('Recovery metadata exceeds the size limit');
    chunks.push(Buffer.from(chunk));
  }
  if (size !== undefined && length !== size) throw new Error('Recovery metadata was truncated');
  const bytes = Buffer.concat(chunks, length);
  if (!isUtf8(bytes)) throw new Error('Recovery metadata must be valid UTF-8');
  return bytes;
}

/** Thin immutable AWS receipts, not a replacement for the native backup catalog. */
export function recoveryStore(target: AwsTarget, uri: string) {
  const location = parseVaultUri(uri);
  const client = new S3Client(awsClientConfig(target));
  const key = (name: string) => {
    const full = `${location.prefix}/${relativeKey(name)}`;
    if (Buffer.byteLength(full, 'utf8') > 1024)
      throw new Error('Recovery metadata key exceeds the S3 key limit');
    return full;
  };
  const common = { Bucket: location.bucket, ExpectedBucketOwner: target.account };
  const readBytes = async (name: string, versionId?: string, signal?: AbortSignal) => {
    if (versionId !== undefined) objectVersion(versionId);
    try {
      const result = await client.send(
        new GetObjectCommand({ ...common, Key: key(name), VersionId: versionId }),
        { abortSignal: signal },
      );
      // Do not buffer a response that cannot be used, and release its socket on rejection.
      try {
        const actualVersion = objectVersion(result.VersionId);
        if (versionId && actualVersion !== versionId)
          throw new Error('S3 returned a different recovery metadata version');
        return {
          body: await readBody(result.Body, result.ContentLength),
          versionId: actualVersion,
        };
      } finally {
        if (result.Body && 'destroy' in result.Body && typeof result.Body.destroy === 'function')
          result.Body.destroy();
      }
    } catch (error) {
      if (!versionId && error instanceof Error && error.name === 'NoSuchKey') return undefined;
      throw error;
    }
  };
  return {
    location,
    async read(
      name: string,
      options: { versionId?: string; signal?: AbortSignal } = {},
    ): Promise<RecoveryMetadata | undefined> {
      const result = await readBytes(name, options.versionId, options.signal);
      if (!result) return undefined;
      return {
        value: JSON.parse(result.body.toString('utf8')),
        versionId: result.versionId,
        checksumSHA256: digest(result.body),
      };
    },
    async putImmutable(
      name: string,
      value: unknown,
      options: { signal?: AbortSignal } = {},
    ): Promise<RecoveryMetadata> {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error('Recovery metadata must be JSON');
      const body = Buffer.from(serialized);
      if (body.byteLength > MAX_METADATA_BYTES)
        throw new Error('Recovery metadata exceeds the size limit');
      let versionId: string | undefined;
      try {
        const result = await client.send(
          new PutObjectCommand({
            ...common,
            Key: key(name),
            Body: body,
            ContentLength: body.byteLength,
            ContentType: 'application/json',
            IfNoneMatch: '*',
            ChecksumSHA256: digest(body),
          }),
          { abortSignal: options.signal },
        );
        versionId = result.VersionId;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'PreconditionFailed') throw error;
        // Retry adoption is allowed only for byte-identical immutable content.
      }
      const stored = await readBytes(name, versionId, options.signal);
      if (!stored || !stored.body.equals(body))
        throw new Error('Recovery metadata collision or failed exact-version readback');
      return {
        value: JSON.parse(serialized),
        versionId: stored.versionId,
        checksumSHA256: digest(stored.body),
      };
    },
    close() {
      client.destroy();
    },
  };
}
