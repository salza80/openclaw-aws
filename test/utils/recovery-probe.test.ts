import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { recoveryBootstrapProbeScript } from '../../src/aws/recovery-probe.js';
import { restoreJobFixture } from '../helpers/fixtures/backup.js';

describe('live recovery bootstrap facts', () => {
  const { bootstrap, target } = restoreJobFixture;
  const marker = {
    schemaVersion: 1,
    operationId: bootstrap.operationId,
    stackId: target.stackId,
    openclaw: bootstrap.runtime.openclaw,
    node: bootstrap.runtime.node,
    gateway: 'masked',
  };
  function run(states: string, input = marker) {
    const output = vi.fn();
    runInNewContext(recoveryBootstrapProbeScript(target.stackId, bootstrap), {
      require(name: string) {
        if (name === 'node:fs') return { readFileSync: () => JSON.stringify(input) };
        if (name === 'node:util')
          // Compare JSON data across VM realms rather than prototypes.
          return {
            isDeepStrictEqual: (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b),
          };
        if (name === 'node:child_process') return { execFileSync: () => states };
        throw new Error('Unexpected dependency');
      },
      console: { log: output },
    });
    return JSON.parse(output.mock.calls[0][0]);
  }
  it('interprets real systemctl newlines and reports only bounded facts', () => {
    expect(run('inactive\nmasked\n')).toEqual({ verified: true, masked: true, inactive: true });
    expect(run('loaded\nactive\n')).toEqual({ verified: true, masked: false, inactive: false });
    expect(run('failed\nmasked\n')).toEqual({ verified: true, masked: true, inactive: true });
  });
  it('refuses an unrelated bootstrap operation before reporting live status', () => {
    expect(() => run('inactive\nmasked\n', { ...marker, operationId: 'other' })).toThrow(
      'identity differs',
    );
  });
});
