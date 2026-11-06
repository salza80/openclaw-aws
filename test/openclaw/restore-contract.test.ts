import { describe, expect, it } from 'vitest';
import { parseRestoreJob } from '../../src/openclaw/restore-contract.js';
import { restoreJobFixture } from '../helpers/fixtures/backup.js';
import { BEDROCK_PLUGIN } from '../../src/openclaw/bedrock-configuration.js';
describe('restore worker request boundary', () => {
  it('binds Bedrock target permissions to the complete saved default/agent/fallback intent', () => {
    const job = structuredClone(restoreJobFixture);
    const model = 'amazon-bedrock/provider.saved',
      arn = 'arn:aws:bedrock:eu-central-1::foundation-model/provider.saved';
    const intent = {
      authMode: 'instance-role' as const,
      inferenceRegion: 'eu-central-1',
      models: [model],
      plugin: BEDROCK_PLUGIN,
    };
    job.backup.capture.credentials.bedrock = intent;
    expect(() => parseRestoreJob(job)).toThrow(/differs from the saved/);
    const planned = {
      ...job,
      bedrock: {
        intent,
        selection: {
          discoveryRegion: intent.inferenceRegion,
          routes: [
            {
              model,
              region: intent.inferenceRegion,
              kind: 'foundation-model',
              invocationArn: arn,
              modelArns: [arn],
            },
          ],
        },
      },
    };
    expect(parseRestoreJob(planned).bedrock).toEqual(planned.bedrock);
    expect(() =>
      parseRestoreJob({
        ...planned,
        bedrock: { ...planned.bedrock, selection: { ...planned.bedrock.selection, routes: [] } },
      }),
    ).toThrow();
  });
  it('preserves pinned old vault identities for a new same-account region/role', () => {
    const parsed = parseRestoreJob(restoreJobFixture);
    expect(parsed.target.region).toBe('us-east-1');
    expect(parsed.backup.job.settings.region).toBe('eu-central-1');
    expect(parsed.target.roleId).not.toBe(parsed.backup.job.source.roleId);
  });
  it('refuses foreign target identities, arbitrary executable paths and incompatible runtime snapshots', () => {
    for (const mutate of [
      (job: typeof restoreJobFixture) => {
        job.target.account = '999999999999';
      },
      (job: typeof restoreJobFixture) => {
        job.target.stackId = job.target.stackId.replace('restored/', 'another/');
      },
      (job: typeof restoreJobFixture) => {
        job.target.instanceId = 'other';
      },
      (job: typeof restoreJobFixture) => {
        job.pluginDirectory = '/tmp/arbitrary';
      },
      (job: typeof restoreJobFixture) => {
        job.bootstrap.runtime.node = '25.0.0';
      },
      (job: typeof restoreJobFixture) => {
        job.backup.capture.operationId = '33333333-3333-3333-3333-333333333333';
      },
    ]) {
      const job = structuredClone(restoreJobFixture);
      mutate(job);
      expect(() => parseRestoreJob(job)).toThrow();
    }
  });
});
