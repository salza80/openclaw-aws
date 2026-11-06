import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { adoptRecoveryActivation } from '../../src/openclaw/recovery-activation-control.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'recovery-adoption-'));
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});
describe('lost activation reply adoption', () => {
  async function fixture() {
    const activatedFile = path.join(directory, 'activated.json');
    const expected = { operationId: 'owned', phase: 'active', healthy: true };
    await writeFile(activatedFile, JSON.stringify(expected), { mode: 0o600 });
    return {
      activatedFile,
      expected,
      validate: vi.fn(async () => {}),
      health: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      assertInactive: vi.fn(async () => {}),
      assertMaintenance: vi.fn(async () => {}),
    };
  }
  it('adopts a valid healthy reply and releases its hold without restarting', async () => {
    const input = await fixture();
    expect(await adoptRecoveryActivation(input)).toBe(true);
    expect(input.release).toHaveBeenCalledOnce();
    expect(input.assertInactive).not.toHaveBeenCalled();
  });
  it('retries a rolled-back commit only under a verified inactive owned hold', async () => {
    const input = await fixture();
    input.health.mockRejectedValue(new Error('inactive'));
    expect(await adoptRecoveryActivation(input)).toBe(false);
    expect(input.assertInactive).toHaveBeenCalledOnce();
    expect(input.assertMaintenance).toHaveBeenCalledOnce();
    input.assertInactive.mockRejectedValueOnce(new Error('still running'));
    await expect(adoptRecoveryActivation(input)).rejects.toThrow('still running');
    input.assertMaintenance.mockRejectedValueOnce(new Error('foreign operation'));
    await expect(adoptRecoveryActivation(input)).rejects.toThrow('foreign operation');
  });
  it('refuses changed receipts or unsafe native state before health/adoption', async () => {
    const input = await fixture();
    await expect(
      adoptRecoveryActivation({ ...input, expected: { phase: 'different' } }),
    ).rejects.toThrow('differs');
    input.validate.mockRejectedValue(new Error('integrations changed'));
    await expect(adoptRecoveryActivation(input)).rejects.toThrow('integrations changed');
    expect(input.health).not.toHaveBeenCalled();
  });
});
