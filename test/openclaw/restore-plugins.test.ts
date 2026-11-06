import { describe, expect, it } from 'vitest';
import {
  assertRestoredPluginHealth,
  restoredPluginInstalls,
  verifyRestoredPluginInstalls,
} from '../../src/openclaw/restore-plugins.js';
const registry = (record: unknown) => ({ current: { installRecords: { sample: record } } });
describe('native restored plugin provenance', () => {
  it('rebuilds from exact npm provenance rather than the original floating spec', () => {
    expect(
      restoredPluginInstalls(
        registry({
          source: 'npm',
          spec: 'sample@latest',
          resolvedName: '@example/sample',
          resolvedVersion: '1.2.3',
          integrity: 'sha512-YWJjZA==',
        }),
      ),
    ).toEqual([{ id: 'sample', spec: 'npm:@example/sample@1.2.3', integrity: 'sha512-YWJjZA==' }]);
  });
  it('refuses missing or floating resolution and detects changed package bytes', () => {
    expect(() =>
      restoredPluginInstalls(
        registry({ source: 'npm', resolvedName: 'sample', resolvedVersion: 'latest' }),
      ),
    ).toThrow('exact');
    expect(() =>
      verifyRestoredPluginInstalls(
        [{ id: 'sample', spec: 'npm:sample@1.0.0', integrity: 'sha512-YWJjZA==' }],
        registry({
          source: 'npm',
          resolvedName: 'sample',
          resolvedVersion: '1.0.0',
          integrity: 'sha512-YWJjZQ==',
        }),
      ),
    ).toThrow('provenance');
  });
  it('leaves non-npm source recovery to native diagnostics instead of guessing a download', () => {
    expect(
      restoredPluginInstalls(registry({ source: 'path', sourcePath: '/private/plugin' })),
    ).toEqual([]);
  });
});

describe('restored plugin diagnostic boundary', () => {
  const source = '~/.openclaw-aws/plugins/hash/index.js';
  const report = () => ({
    ok: false,
    pluginErrors: [],
    diagnostics: [
      {
        level: 'warn',
        pluginId: 'openclaw-aws-s3',
        source,
        message: "OpenClaw can't verify where this plugin came from. reason=record-missing;",
      },
    ],
    sourceShadowing: [],
    compatibility: [],
    configurationWarnings: [],
  });
  it('accepts only the exact managed transport provenance warning', () => {
    expect(() => assertRestoredPluginHealth(report(), [source])).not.toThrow();
    expect(() => assertRestoredPluginHealth(report(), ['/another/index.js'])).toThrow('failed');
    const failure = report();
    failure.diagnostics[0].message = 'Missing dependency';
    expect(() => assertRestoredPluginHealth(failure, [source])).toThrow('failed');
  });
  it('refuses partial workspace inspection, load failures and incomplete native reports', () => {
    const partial = report();
    partial.diagnostics[0].pluginId = 'workspace-scope-omitted';
    expect(() => assertRestoredPluginHealth(partial, [source])).toThrow('failed');
    expect(() => assertRestoredPluginHealth({ ok: true }, [source])).toThrow('incomplete');
    expect(() =>
      assertRestoredPluginHealth({ ...report(), pluginErrors: [{ id: 'broken' }] }, [source]),
    ).toThrow('failed');
  });
});
