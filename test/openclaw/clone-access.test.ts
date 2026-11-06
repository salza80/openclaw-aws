import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCloneJob } from '../../src/openclaw/clone-contract.js';
import { restoreJobFixture } from '../helpers/fixtures/backup.js';
const mocks = vi.hoisted(() => ({
  secret: vi.fn(),
  s3: vi.fn(),
  secretDestroy: vi.fn(),
  s3Destroy: vi.fn(),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (load) => ({
  ...(await load<object>()),
  SecretsManagerClient: class {
    send = mocks.secret;
    destroy = mocks.secretDestroy;
  },
}));
vi.mock('@aws-sdk/client-s3', async (load) => ({
  ...(await load<object>()),
  S3Client: class {
    send = mocks.s3;
    destroy = mocks.s3Destroy;
  },
}));
import { assertCloneSourceAccessRevoked } from '../../src/openclaw/clone-access.js';
const job = parseCloneJob({
  ...restoreJobFixture,
  kind: 'clone',
  preview: { contentDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64) },
  credentials: { primary: 'openrouter-api-key', providers: ['openrouter-api-key'] },
});
const credentials = async () => ({ accessKeyId: 'fixture', secretAccessKey: 'fixture' });
const denied = () => Object.assign(new Error('private AWS response'), { name: 'AccessDenied' });
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('clone source-access revocation', () => {
  it('waits for both denied exact-version reads before activation', async () => {
    mocks.secret
      .mockResolvedValueOnce({ SecretString: 'private-source-key' })
      .mockRejectedValue(denied());
    mocks.s3.mockResolvedValueOnce({}).mockRejectedValue(denied());
    const pending = assertCloneSourceAccessRevoked(job, credentials);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(mocks.secret).toHaveBeenCalledTimes(2);
    expect(mocks.s3.mock.calls[0][0].input).toMatchObject({
      Key:
        job.backup.job.settings.prefix +
        '/backups/' +
        job.backup.job.namespace +
        '/' +
        job.backup.capture.capture.location.key,
      VersionId: 'archive-version',
      ExpectedBucketOwner: job.target.account,
    });
    expect(mocks.secret.mock.calls[0][0].input).toMatchObject({
      VersionId: job.backup.job.key.versionId,
      VersionStage: job.backup.job.key.versionStage,
    });
    expect(mocks.secretDestroy).toHaveBeenCalledOnce();
    expect(mocks.s3Destroy).toHaveBeenCalledOnce();
  });
  it('does not count missing objects, timeouts or unclassified errors as denied access', async () => {
    mocks.secret.mockRejectedValue(denied());
    mocks.s3.mockRejectedValue(
      Object.assign(new Error('sensitive SDK details'), { name: 'NotFound' }),
    );
    await expect(assertCloneSourceAccessRevoked(job, credentials)).rejects.toThrow(
      'could not be verified',
    );
    expect(mocks.s3Destroy).toHaveBeenCalledOnce();
  });
  it('keeps activation withheld when IAM permissions remain usable', async () => {
    mocks.secret.mockResolvedValue({ SecretString: 'never-publish' });
    mocks.s3.mockResolvedValue({});
    const pending = expect(assertCloneSourceAccessRevoked(job, credentials)).rejects.toThrow(
      'still available',
    );
    await vi.advanceTimersByTimeAsync(120001);
    await pending;
  });
});
