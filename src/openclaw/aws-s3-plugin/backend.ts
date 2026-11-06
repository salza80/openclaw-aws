import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import type {
  StorageBackend,
  StorageObjectInfo,
  StorageProviderOpenParams,
} from 'openclaw/plugin-sdk/plugin-entry';
import { parseSettings, relativeKey } from './settings.js';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';

// Bounded buffering, including streams whose encrypted size is not known yet.
const PART_BYTES = 8 * 1024 * 1024;
export const MAX_OBJECT_BYTES = PART_BYTES * 10000;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64');
const missingKey = (error: unknown) =>
  error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name);
function byteStream(body: unknown): AsyncIterable<Uint8Array> {
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function')
    throw new Error('S3 did not return a readable object stream');
  return body as AsyncIterable<Uint8Array>;
}

/** Native OpenClaw owns encryption, markers, archive formats and namespaces. */
export async function openS3Backend(params: StorageProviderOpenParams): Promise<StorageBackend> {
  const settings = parseSettings(params.settings);
  const common = { Bucket: settings.bucket, ExpectedBucketOwner: settings.expectedBucketOwner };
  const objectKey = (key: string, allowEmpty = false) => {
    relativeKey(key, allowEmpty);
    const full = `${settings.prefix}/${key}`;
    if (Buffer.byteLength(full, 'utf8') > 1024)
      throw new Error('S3 storage key exceeds the object-key limit');
    return full;
  };
  const operationId = process.env.OPENCLAW_AWS_BACKUP_OPERATION_ID;
  if (operationId && !/^[a-zA-Z0-9-]{1,128}$/.test(operationId))
    throw new Error('Invalid backup operation identifier');
  const client = new S3Client({
    region: settings.region,
    ...(settings.credentialSource === 'instance-role'
      ? {
          credentials: fromInstanceMetadata({
            ec2MetadataV1Disabled: true,
            timeout: 3000,
            maxRetries: 2,
          }),
        }
      : {}),
  });
  const tagging = operationId
    ? `openclaw-aws-operation=${encodeURIComponent(operationId)}`
    : undefined;
  const sendOptions = (signal?: AbortSignal) => ({ abortSignal: signal ?? params.signal });
  const assertWritable = () => {
    if (settings.readOnly || settings.readVersions.size)
      throw new Error('This S3 storage view is read-only');
  };
  const version = (key: string) => {
    const value = settings.readVersions.get(key);
    if (settings.readVersions.size && !value)
      throw new Error('Object is outside the exact-version recovery view');
    return value;
  };
  const backend: StorageBackend = {
    displayTarget: `s3://${settings.bucket}/${settings.prefix}/`,
    async probe(opts) {
      if (settings.readOnly || settings.readVersions.size) {
        await client.send(
          new ListObjectsV2Command({ ...common, Prefix: objectKey('', true), MaxKeys: 1 }),
          sendOptions(opts?.signal),
        );
        return {};
      }
      const key = objectKey(`${settings.probePrefix}/${randomUUID()}`);
      const body = randomBytes(32);
      let versionId: string | undefined;
      let created = false;
      try {
        const result = await client.send(
          new PutObjectCommand({
            ...common,
            Key: key,
            Body: body,
            ContentLength: body.length,
            ChecksumSHA256: sha256(body),
            IfNoneMatch: '*',
          }),
          sendOptions(opts?.signal),
        );
        created = true;
        versionId = result.VersionId;
        const read = await client.send(
          new GetObjectCommand({ ...common, Key: key, VersionId: versionId }),
          sendOptions(opts?.signal),
        );
        const chunks: Uint8Array[] = [];
        let count = 0;
        for await (const chunk of byteStream(read.Body)) {
          count += chunk.byteLength;
          if (count > body.length) throw new Error('S3 probe returned unexpected data');
          chunks.push(chunk);
        }
        if (!Buffer.concat(chunks).equals(body)) throw new Error('S3 probe readback did not match');
        return {};
      } finally {
        // Remove precisely our probe version, without accumulating delete markers.
        if (created)
          await client.send(
            new DeleteObjectCommand({ ...common, Key: key, VersionId: versionId }),
            { abortSignal: AbortSignal.timeout(10000) },
          );
      }
    },
    async putObject(key, body, opts) {
      assertWritable();
      const fullKey = objectKey(key);
      if (
        opts.sizeBytes !== undefined &&
        (!Number.isSafeInteger(opts.sizeBytes) || opts.sizeBytes < 0)
      )
        throw new Error('Invalid exact S3 stream size');
      if (opts.sizeBytes !== undefined && opts.sizeBytes > MAX_OBJECT_BYTES)
        throw new Error('S3 backup transport supports objects up to 78.125 GiB');
      const signal = opts.signal ?? params.signal;
      let uploadId: string | undefined;
      let complete = false;
      let size = 0;
      let buffered: Buffer[] = [];
      let bufferedBytes = 0;
      const parts: CompletedPart[] = [];
      const startMultipart = async () => {
        const result = await client.send(
          new CreateMultipartUploadCommand({
            ...common,
            Key: fullKey,
            ChecksumAlgorithm: 'SHA256',
            Tagging: tagging,
          }),
          sendOptions(signal),
        );
        if (!result.UploadId) throw new Error('S3 did not return a multipart upload ID');
        uploadId = result.UploadId;
      };
      const upload = async (part: Buffer) => {
        if (parts.length >= 10000) throw new Error('S3 multipart part limit exceeded');
        const partNumber = parts.length + 1;
        const checksum = sha256(part);
        const result = await client.send(
          new UploadPartCommand({
            ...common,
            Key: fullKey,
            UploadId: uploadId!,
            PartNumber: partNumber,
            Body: part,
            ContentLength: part.length,
            ChecksumSHA256: checksum,
          }),
          sendOptions(signal),
        );
        if (!result.ETag) throw new Error('S3 did not confirm a multipart part');
        parts.push({ PartNumber: partNumber, ETag: result.ETag, ChecksumSHA256: checksum });
      };
      try {
        for await (const chunk of body) {
          signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array))
            throw new Error('S3 upload stream must contain byte chunks');
          size += chunk.byteLength;
          if (
            !Number.isSafeInteger(size) ||
            size > MAX_OBJECT_BYTES ||
            (opts.sizeBytes !== undefined && size > opts.sizeBytes)
          )
            throw new Error('S3 upload stream exceeded its declared or maximum size');
          let offset = 0;
          while (offset < chunk.byteLength) {
            const take = Math.min(PART_BYTES - bufferedBytes, chunk.byteLength - offset);
            // Copy only the bounded slice rather than retaining an oversized source buffer.
            buffered.push(Buffer.from(chunk.subarray(offset, offset + take)));
            bufferedBytes += take;
            offset += take;
            if (bufferedBytes === PART_BYTES) {
              if (!uploadId) await startMultipart();
              await upload(Buffer.concat(buffered, bufferedBytes));
              buffered = [];
              bufferedBytes = 0;
            }
          }
        }
        signal?.throwIfAborted();
        if (opts.sizeBytes !== undefined && size !== opts.sizeBytes)
          throw new Error('S3 upload stream did not match its declared size');
        const remaining = Buffer.concat(buffered, bufferedBytes);
        if (!uploadId) {
          await client.send(
            new PutObjectCommand({
              ...common,
              Key: fullKey,
              Body: remaining,
              ContentLength: size,
              ChecksumSHA256: sha256(remaining),
              IfNoneMatch: '*',
              Tagging: tagging,
            }),
            sendOptions(signal),
          );
        } else {
          if (remaining.length) await upload(remaining);
          await client.send(
            new CompleteMultipartUploadCommand({
              ...common,
              Key: fullKey,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
              IfNoneMatch: '*',
            }),
            sendOptions(signal),
          );
        }
        complete = true;
        return { sizeBytes: size };
      } finally {
        if (uploadId && !complete) {
          try {
            await client.send(
              new AbortMultipartUploadCommand({ ...common, Key: fullKey, UploadId: uploadId }),
              { abortSignal: AbortSignal.timeout(10000) },
            );
          } catch {
            /* The vault lifecycle must also expire abandoned multipart sessions. */
          }
        }
      }
    },
    async getObject(key, opts) {
      try {
        const result = await client.send(
          new GetObjectCommand({ ...common, Key: objectKey(key), VersionId: version(key) }),
          sendOptions(opts?.signal),
        );
        return byteStream(result.Body);
      } catch (error) {
        if (!version(key) && missingKey(error)) return undefined;
        throw error;
      }
    },
    async statObject(key, opts) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ ...common, Key: objectKey(key), VersionId: version(key) }),
          sendOptions(opts?.signal),
        );
        if (
          result.ContentLength === undefined ||
          !Number.isSafeInteger(result.ContentLength) ||
          result.ContentLength < 0
        )
          throw new Error('S3 returned incomplete object size metadata');
        return { key, sizeBytes: result.ContentLength, modifiedAt: result.LastModified?.getTime() };
      } catch (error) {
        if (!version(key) && missingKey(error)) return undefined;
        throw error;
      }
    },
    async *listObjects(prefix, opts) {
      objectKey(prefix, true);
      if (settings.readVersions.size) {
        // Listing current objects would hide a recovery point behind a delete marker.
        for (const key of settings.readVersions.keys()) {
          if (!key.startsWith(prefix)) continue;
          const exact = await backend.statObject(key, opts);
          if (exact) yield exact;
        }
        return;
      }
      let continuation: string | undefined;
      const cursors = new Set<string>();
      const requested = objectKey(prefix, true);
      do {
        const result = await client.send(
          new ListObjectsV2Command({
            ...common,
            Prefix: requested,
            ContinuationToken: continuation,
          }),
          sendOptions(opts?.signal),
        );
        for (const item of result.Contents ?? []) {
          if (
            !item.Key ||
            !item.Key.startsWith(requested) ||
            !item.Key.startsWith(`${settings.prefix}/`) ||
            item.Size === undefined ||
            !Number.isSafeInteger(item.Size) ||
            item.Size < 0
          )
            throw new Error('S3 returned invalid object listing metadata');
          const key = item.Key.slice(settings.prefix.length + 1);
          if (!key && item.Size === 0) continue; // Console-created folder placeholder.
          relativeKey(key);
          yield {
            key,
            sizeBytes: item.Size,
            modifiedAt: item.LastModified?.getTime(),
          } satisfies StorageObjectInfo;
        }
        if (!result.IsTruncated) break;
        if (!result.NextContinuationToken || cursors.has(result.NextContinuationToken))
          throw new Error('S3 returned an invalid pagination cursor');
        cursors.add(result.NextContinuationToken);
        continuation = result.NextContinuationToken;
      } while (true);
    },
    async deleteObject(key, opts) {
      assertWritable();
      await client.send(
        new DeleteObjectCommand({ ...common, Key: objectKey(key) }),
        sendOptions(opts?.signal),
      );
    },
    async close() {
      client.destroy();
    },
  };
  return backend;
}
