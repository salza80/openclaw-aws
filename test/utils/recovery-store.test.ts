import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), options: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send = mocks.send;
    destroy = mocks.destroy;
    constructor(options: unknown) {
      mocks.options(options);
    }
  },
}));
import { parseVaultUri, recoveryStore } from '../../src/aws/recovery-store.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const uri = 's3://private-backups/vault/main';
const point = { schemaVersion: 1, id: 'recovery-point', complete: true };
const bytes = Buffer.from(JSON.stringify(point));
function body(data: Buffer = bytes) {
  const destroy = vi.fn();
  return {
    destroy,
    async *[Symbol.asyncIterator]() {
      yield data;
    },
  };
}
beforeEach(() => vi.resetAllMocks());

describe('independent AWS recovery metadata', () => {
  it('parses a clean-client vault locator without normalizing traversal or accepting endpoints', () => {
    expect(parseVaultUri(`${uri}/`)).toEqual({ bucket: 'private-backups', prefix: 'vault/main' });
    for (const value of [
      'https://private-backups/vault',
      's3://private-backups/',
      's3://private-backups/a/../b',
      's3://private-backups/a/%2e%2e/b',
      's3://private-backups/a?region=x',
      's3://private-backups/a#x',
      's3://private-backups/a//b',
      's3://1.2.3.4/vault',
    ])
      expect(() => parseVaultUri(value)).toThrow();
  });
  it('commits only after byte-identical readback of the uploaded S3 version', async () => {
    const stream = body();
    mocks.send.mockResolvedValueOnce({ VersionId: 'committed-version' }).mockResolvedValueOnce({
      VersionId: 'committed-version',
      Body: stream,
      ContentLength: bytes.length,
    });
    const store = recoveryStore(testTarget, uri);
    expect(mocks.options).toHaveBeenCalledWith({
      region: testTarget.region,
      credentials: testTarget.credentials,
    });
    expect(await store.putImmutable('receipts/point.json', point)).toMatchObject({
      value: point,
      versionId: 'committed-version',
      checksumSHA256: expect.any(String),
    });
    const put = mocks.send.mock.calls[0][0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'private-backups',
      ExpectedBucketOwner: testTarget.account,
      Key: 'vault/main/receipts/point.json',
      IfNoneMatch: '*',
      Body: bytes,
      ChecksumSHA256: expect.any(String),
    });
    const read = mocks.send.mock.calls[1][0];
    expect(read).toBeInstanceOf(GetObjectCommand);
    expect(read.input.VersionId).toBe('committed-version');
    expect(stream.destroy).toHaveBeenCalledOnce();
    store.close();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('adopts a byte-identical completed receipt on retry without overwriting it', async () => {
    mocks.send
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'PreconditionFailed' }))
      .mockResolvedValueOnce({
        VersionId: 'original-version',
        Body: body(),
        ContentLength: bytes.length,
      });
    expect(
      await recoveryStore(testTarget, uri).putImmutable('receipts/point.json', point),
    ).toMatchObject({ versionId: 'original-version' });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it('rejects occupied receipt IDs with different content', async () => {
    mocks.send
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'PreconditionFailed' }))
      .mockResolvedValueOnce({
        VersionId: 'other',
        Body: body(Buffer.from('{}')),
        ContentLength: 2,
      });
    await expect(
      recoveryStore(testTarget, uri).putImmutable('receipts/point.json', point),
    ).rejects.toThrow(/collision/);
  });
  it.each([
    { VersionId: undefined, Body: body() },
    { VersionId: 'null', Body: body() },
    { VersionId: 'wrong-version', Body: body() },
    { VersionId: 'expected-version', Body: body(), ContentLength: bytes.length + 1 },
    { VersionId: 'expected-version', Body: body(), ContentLength: 128 * 1024 + 1 },
    { VersionId: 'expected-version', Body: body(Buffer.alloc(128 * 1024 + 1)) },
    { VersionId: 'expected-version', Body: body(Buffer.from([0xff])) },
    { VersionId: 'expected-version', Body: body(Buffer.from('not json')) },
  ])('rejects unusable metadata and releases the response stream', async (result) => {
    mocks.send.mockResolvedValue(result);
    await expect(
      recoveryStore(testTarget, uri).read('vault.json', { versionId: 'expected-version' }),
    ).rejects.toThrow();
    expect(result.Body.destroy).toHaveBeenCalledOnce();
  });
  it('distinguishes absent current metadata from unavailable pinned recovery versions', async () => {
    const error = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    mocks.send.mockRejectedValue(error);
    const store = recoveryStore(testTarget, uri);
    expect(await store.read('vault.json')).toBeUndefined();
    await expect(store.read('vault.json', { versionId: 'saved' })).rejects.toBe(error);
  });
  it.each(['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId'])(
    'preserves %s without inferring absence or attempting a write',
    async (name) => {
      const error = Object.assign(new Error(name), { name });
      mocks.send.mockRejectedValue(error);
      await expect(recoveryStore(testTarget, uri).read('vault.json')).rejects.toBe(error);
      expect(mocks.send).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects invalid receipt keys or oversized payloads before sending anything', async () => {
    const store = recoveryStore(testTarget, uri);
    await expect(store.putImmutable('../escape', point)).rejects.toThrow();
    await expect(
      store.putImmutable('large.json', { data: 'x'.repeat(128 * 1024) }),
    ).rejects.toThrow(/size/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
