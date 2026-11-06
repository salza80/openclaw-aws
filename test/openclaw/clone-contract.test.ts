import { describe, expect, it } from 'vitest';
import { parseCloneJob, cloneRequestDigest } from '../../src/openclaw/clone-contract.js';
import { restoreJobFixture } from '../helpers/fixtures/backup.js';
import { cloneBedrockPlan } from '../helpers/fixtures/clone.js';
import { parseRestoreJob } from '../../src/openclaw/restore-contract.js';
import { explicitCloneCredentials } from '../../src/openclaw/clone-credentials.js';
const fixture = () => ({
  ...structuredClone(restoreJobFixture),
  kind: 'clone',
  preview: { contentDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64) },
  credentials: { primary: 'openrouter-api-key', providers: ['openrouter-api-key'] },
});
describe('clone request boundary', () => {
  it('accepts reviewed keyless and mixed-provider clones, separate from source conversation grants', () => {
    const bedrock = cloneBedrockPlan();
    const job = {
      ...fixture(),
      bedrock,
      credentials: { primary: 'amazon-bedrock', providers: [] },
    };
    expect(parseCloneJob(job).credentials.providers).toEqual([]);
    expect(explicitCloneCredentials('amazon-bedrock', {}).environment).toEqual({});
    expect(
      parseCloneJob({
        ...job,
        credentials: { primary: 'amazon-bedrock', providers: ['openrouter-api-key'] },
      }).credentials.providers,
    ).toEqual(['openrouter-api-key']);
    expect(() => parseCloneJob({ ...job, bedrock: undefined })).toThrow();
    expect(() => parseRestoreJob(job)).toThrow(/kind/);
    expect(() =>
      explicitCloneCredentials('amazon-bedrock', { 'amazon-bedrock': 'invented-key' } as never),
    ).toThrow(/unsupported/);
  });
  it('binds preview and credential selection separately from restore identity transport', () => {
    const parsed = parseCloneJob(fixture());
    expect(parsed.kind).toBe('clone');
    const before = cloneRequestDigest(parsed);
    parsed.preview.policyDigest = 'c'.repeat(64);
    expect(cloneRequestDigest(parsed)).not.toBe(before);
  });
  it('rejects a restore invocation, unreviewed content, source-role path traversal and implicit or duplicate providers', () => {
    const invalid = [
      { ...fixture(), kind: 'restore' },
      { ...fixture(), preview: { contentDigest: 'unreviewed', policyDigest: 'b'.repeat(64) } },
      { ...fixture(), credentials: { primary: 'openrouter-api-key', providers: [] } },
      {
        ...fixture(),
        credentials: {
          primary: 'openrouter-api-key',
          providers: ['openrouter-api-key', 'openrouter-api-key'],
        },
      },
      { ...fixture(), credentials: { primary: 'source-channel', providers: ['source-channel'] } },
      {
        ...fixture(),
        credentials: {
          primary: 'cloudflare-ai-gateway-api-key',
          providers: ['cloudflare-ai-gateway-api-key'],
        },
      },
    ];
    for (const candidate of invalid) expect(() => parseCloneJob(candidate)).toThrow();
    const member = fixture();
    member.backup.capture.members[0].id = '../source';
    expect(() => parseCloneJob(member)).toThrow();
  });
});
