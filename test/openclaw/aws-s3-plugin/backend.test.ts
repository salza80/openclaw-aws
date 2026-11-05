import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
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
import { openS3Backend, MAX_OBJECT_BYTES } from '../../../src/openclaw/aws-s3-plugin/backend.js';
import {
  parseSettings,
  validateS3Settings,
  describeS3Target,
} from '../../../src/openclaw/aws-s3-plugin/settings.js';

const settings = {
  bucket: 'private-backups',
  prefix: 'vault/main',
  region: 'eu-central-1',
  expectedBucketOwner: '123456789012',
};
const common = { Bucket: settings.bucket, ExpectedBucketOwner: settings.expectedBucketOwner };
const open = (extra = {}) =>
  openS3Backend({
    locationName: 'vault',
    settings: { ...settings, ...extra },
    resolveSecret: async () => {
      throw new Error('No static credentials');
    },
  });
async function* bytes(...values: Uint8Array[]) {
  yield* values;
}
async function collect<T>(source: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OPENCLAW_AWS_BACKUP_OPERATION_ID', 'operation-1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AWS S3 native settings', () => {
  it('requires a bounded explicit AWS target and refuses static credential settings', () => {
    expect(parseSettings(settings).prefix).toBe('vault/main');
    expect(describeS3Target(settings)).toBe('s3://private-backups/vault/main/');
    for (const extra of [
      { accessKeyId: 'private' },
      { prefix: '../other' },
      { prefix: '/' },
      { prefix: 'a//b' },
      { prefix: 'é'.repeat(257) },
      { region: undefined },
      { expectedBucketOwner: '' },
      { readVersions: { '../escape': 'v1' } },
      { readVersions: { key: 'null' } },
      { readOnly: 'true' },
      { bucket: '1.2.3.4' },
    ])
      expect(validateS3Settings({ ...settings, ...extra })).toEqual(expect.any(String));
  });
  it('uses the refreshable AWS credential chain rather than captured credentials', async () => {
    await open();
    expect(mocks.options).toHaveBeenCalledWith({ region: 'eu-central-1' });
  });
});

describe('native S3 transport writes', () => {
  it.each([0, 3])(
    'conditionally uploads an exact %i-byte object with checksum and operation provenance',
    async (length) => {
      mocks.send.mockResolvedValue({ VersionId: 'v1' });
      const backend = await open();
      const body = Buffer.alloc(length, 7);
      expect(
        await backend.putObject('backups/device/archive', bytes(body), { sizeBytes: length }),
      ).toEqual({ sizeBytes: length });
      const command = mocks.send.mock.calls[0][0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        ...common,
        Key: 'vault/main/backups/device/archive',
        Body: body,
        ContentLength: length,
        IfNoneMatch: '*',
        Tagging: 'openclaw-aws-operation=operation-1',
        ChecksumSHA256: expect.any(String),
      });
      await backend.close?.();
      expect(mocks.destroy).toHaveBeenCalledOnce();
    },
  );
  it('keeps existing objects on a conditional-write collision', async () => {
    const collision = Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
    mocks.send.mockRejectedValue(collision);
    const backend = await open();
    await expect(backend.putObject('key', bytes(Buffer.from('data')), {})).rejects.toBe(collision);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each([2, 4])(
    'rejects an exact-length mismatch against %i bytes before publishing',
    async (declared) => {
      const backend = await open();
      await expect(
        backend.putObject('key', bytes(Buffer.alloc(3)), { sizeBytes: declared }),
      ).rejects.toThrow(/size/);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it.each([-1, NaN, Infinity, MAX_OBJECT_BYTES + 1])(
    'rejects impossible declared size %s',
    async (sizeBytes) => {
      const backend = await open();
      await expect(backend.putObject('key', bytes(), { sizeBytes })).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it('uploads bounded multipart chunks and completes conditionally', async () => {
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload' };
      if (command instanceof UploadPartCommand) return { ETag: `part-${command.input.PartNumber}` };
      return { VersionId: 'v2' };
    });
    const backend = await open();
    const size = 8 * 1024 * 1024 + 7;
    expect(
      await backend.putObject('large', bytes(Buffer.alloc(size)), { sizeBytes: size }),
    ).toEqual({ sizeBytes: size });
    const commands = mocks.send.mock.calls.map(([command]) => command);
    expect(commands.map((c) => c.constructor.name)).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
    expect(commands[1].input.ContentLength).toBe(8 * 1024 * 1024);
    expect(commands[2].input.ContentLength).toBe(7);
    expect(commands[3].input).toMatchObject({
      ...common,
      IfNoneMatch: '*',
      UploadId: 'upload',
      MultipartUpload: {
        Parts: [
          expect.objectContaining({ PartNumber: 1 }),
          expect.objectContaining({ PartNumber: 2 }),
        ],
      },
    });
  });
  it.each(['stream', 'size', 'collision', 'abort'])(
    'aborts incomplete multipart sessions after %s failure',
    async (failure) => {
      const controller = new AbortController();
      mocks.send.mockImplementation(async (command) => {
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'unfinished' };
        if (command instanceof UploadPartCommand) {
          if (failure === 'abort') controller.abort();
          return { ETag: 'part' };
        }
        if (command instanceof CompleteMultipartUploadCommand) throw new Error('collision');
        return {};
      });
      async function* source() {
        yield Buffer.alloc(8 * 1024 * 1024);
        if (failure === 'stream') throw new Error('broken stream');
      }
      const backend = await open();
      await expect(
        backend.putObject('large', source(), {
          signal: controller.signal,
          sizeBytes: failure === 'size' ? 9 * 1024 * 1024 : undefined,
        }),
      ).rejects.toThrow();
      const last = mocks.send.mock.calls.at(-1)!;
      expect(last[0]).toBeInstanceOf(AbortMultipartUploadCommand);
      expect(last[0].input).toMatchObject({ ...common, UploadId: 'unfinished' });
      expect(last[1].abortSignal.aborted).toBe(false);
    },
  );
  it('probes a private random key and removes precisely its uploaded version', async () => {
    let body: Uint8Array;
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof PutObjectCommand) {
        body = command.input.Body;
        return { VersionId: 'probe-version' };
      }
      if (command instanceof GetObjectCommand) return { Body: bytes(body) };
      return {};
    });
    const backend = await open();
    await backend.probe();
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({
      ...common,
      Key: expect.stringMatching(/^vault\/main\/_probes\//),
      IfNoneMatch: '*',
    });
    const last = mocks.send.mock.calls.at(-1)![0];
    expect(last).toBeInstanceOf(DeleteObjectCommand);
    expect(last.input.VersionId).toBe('probe-version');
  });
});

describe('native S3 recovery reads', () => {
  it('reads the committed version without falling back to current state', async () => {
    mocks.send.mockResolvedValue({ Body: bytes(Buffer.from('old')), ContentLength: 3 });
    const backend = await open({ readVersions: { archive: 'old-version' } });
    expect(Buffer.concat(await collect((await backend.getObject('archive'))!)).toString()).toBe(
      'old',
    );
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({
      ...common,
      Key: 'vault/main/archive',
      VersionId: 'old-version',
    });
    await expect(backend.getObject('uncommitted')).rejects.toThrow(/exact-version/);
    for (const action of [
      () => backend.putObject('archive', bytes(), {}),
      () => backend.deleteObject('archive'),
    ])
      await expect(action()).rejects.toThrow(/read-only/);
  });
  it.each(['NoSuchVersion', 'AccessDenied', 'NoSuchBucket'])(
    'preserves %s failures',
    async (name) => {
      const error = Object.assign(new Error(name), { name });
      mocks.send.mockRejectedValue(error);
      const backend = await open();
      await expect(backend.getObject('key')).rejects.toBe(error);
      await expect(backend.statObject('key')).rejects.toBe(error);
    },
  );
  it('distinguishes missing current keys from missing committed versions', async () => {
    const error = Object.assign(new Error('gone'), { name: 'NoSuchKey' });
    mocks.send.mockRejectedValue(error);
    const backend = await open();
    expect(await backend.getObject('key')).toBeUndefined();
    const exact = await open({ readVersions: { key: 'v1' } });
    await expect(exact.getObject('key')).rejects.toBe(error);
  });
  it('lists committed versions even when current objects are deleted', async () => {
    mocks.send.mockResolvedValue({ ContentLength: 11 });
    const backend = await open({ readVersions: { archive: 'v1', marker: 'v2' } });
    expect(await collect(backend.listObjects('archive'))).toEqual([
      { key: 'archive', sizeBytes: 11, modifiedAt: undefined },
    ]);
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(mocks.send.mock.calls[0][0].input.VersionId).toBe('v1');
  });
  it('paginates only within the requested prefix and ignores root folder placeholders', async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'vault/main/', Size: 0 },
          { Key: 'vault/main/a', Size: 2 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'next',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: 'vault/main/b', Size: 3 }] });
    const backend = await open();
    expect((await collect(backend.listObjects(''))).map((x) => x.key)).toEqual(['a', 'b']);
    expect(mocks.send.mock.calls[1][0]).toBeInstanceOf(ListObjectsV2Command);
    expect(mocks.send.mock.calls[1][0].input).toMatchObject({
      ...common,
      Prefix: 'vault/main/',
      ContinuationToken: 'next',
    });
  });
  it('rejects pagination loops and malformed or escaping listing metadata', async () => {
    const backend = await open();
    mocks.send.mockResolvedValue({ IsTruncated: true, NextContinuationToken: 'same' });
    await expect(collect(backend.listObjects(''))).rejects.toThrow(/pagination/);
    for (const item of [
      { Key: 'elsewhere/key', Size: 1 },
      { Key: 'vault/main/../other', Size: 1 },
      { Key: 'vault/main/key' },
    ]) {
      mocks.send.mockResolvedValue({ Contents: [item] });
      await expect(collect(backend.listObjects(''))).rejects.toThrow();
    }
  });
  it.each(['../escape', '/absolute', 'a/./b', 'a\\b'])(
    'rejects key %s before any AWS request',
    async (key) => {
      const backend = await open();
      await expect(backend.getObject(key)).rejects.toThrow();
      await expect(backend.putObject(key, bytes(), {})).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
});
