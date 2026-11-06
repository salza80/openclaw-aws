import { describe, expect, it } from 'vitest';
import { parseRestoreBootstrap } from '../../src/aws/restore-bootstrap.js';
const runtime = { openclaw: '2026.11.1', node: '24.22.2' };
const operationId = '11111111-1111-1111-1111-111111111111';
describe('internal restore provisioning snapshot', () => {
  it('accepts explicit recorded disk capacity without changing the public v1 config', () => {
    expect(parseRestoreBootstrap({ operationId, volumeGiB: 60, runtime })).toEqual({
      operationId,
      volumeGiB: 60,
      runtime,
    });
  });
  it('refuses missing or incompatible recorded runtime pins before provisioning', () => {
    for (const pins of [
      undefined,
      { openclaw: 'latest', node: '24.22.2' },
      { openclaw: '2026.11.1', node: '26.1.0' },
    ])
      expect(() => parseRestoreBootstrap({ operationId, volumeGiB: 30, runtime: pins })).toThrow(
        'recorded OpenClaw',
      );
  });
  it.each([
    undefined,
    [],
    { operationId },
    { operationId, volumeGiB: 29 },
    { operationId, volumeGiB: 16385 },
    { operationId, volumeGiB: 30.1 },
    { operationId: 'latest', volumeGiB: 30 },
    { operationId, volumeGiB: 30, activate: true },
  ])('refuses incomplete or ambiguous inactive bootstrap input %#', (value) => {
    expect(() => parseRestoreBootstrap(value)).toThrow();
  });
});
