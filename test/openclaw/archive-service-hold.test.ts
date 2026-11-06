import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readlink,
  lstat,
  rename,
  link,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveServiceHold,
  type ArchiveService,
} from '../../src/openclaw/archive-service-hold.js';

const operationId = '11111111-1111-1111-1111-111111111111';
const requestDigest = 'a'.repeat(64);
const definition =
  '[Unit]\nDescription=Original Gateway\n[Service]\nExecStart=/private/native/node original-gateway\n';
let home: string;
let unit: string;
let work: string;
let state: 'active' | 'inactive' | 'failed';
let service: ArchiveService;
let admission: ReturnType<typeof vi.fn>;
const hold = () => archiveServiceHold({ home, operationId, requestDigest, service });
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'archive-service-hold-')));
  unit = path.join(home, '.config/systemd/user/openclaw-gateway.service');
  work = path.join(home, '.openclaw-aws/jobs', operationId);
  await mkdir(path.dirname(unit), { recursive: true, mode: 0o700 });
  await writeFile(unit, definition, { mode: 0o644 });
  state = 'active';
  admission = vi.fn(async () => ({ expiresAtMs: Date.now() + 120000 }));
  service = {
    inspect: vi.fn(async () => ({
      state,
      masked: (await lstat(unit)).isSymbolicLink() && (await readlink(unit)) === '/dev/null',
    })),
    reload: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      state = 'inactive';
    }),
    start: vi.fn(async () => {
      state = 'active';
    }),
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe('owned persistent archive service hold', () => {
  it('persists the original unit and a mask before stopping, then restores the exact unit/inode and readiness', async () => {
    const original = await lstat(unit);
    const controller = await hold();
    await controller.prepare('active');
    await controller.hold(admission);
    expect(await readlink(unit)).toBe('/dev/null');
    expect(await readFile(path.join(work, 'archive-gateway.service'), 'utf8')).toBe(definition);
    expect((await lstat(path.join(work, 'archive-gateway.service'))).ino).toBe(original.ino);
    expect(state).toBe('inactive');
    expect(admission).toHaveBeenCalledTimes(2);
    expect(service.stop).toHaveBeenCalledOnce();
    await controller.assertHeld();
    await controller.restore();
    expect(await readFile(unit, 'utf8')).toBe(definition);
    expect((await lstat(unit)).ino).toBe(original.ino);
    expect((await lstat(unit)).mode & 0o777).toBe(0o644);
    expect(state).toBe('active');
    expect(service.start).toHaveBeenCalledOnce();
    await expect(controller.hold(admission)).rejects.toThrow(/restoration already began/);
  });
  it.each(['inactive', 'failed'] as const)(
    'preserves a previously %s service without native suspension or forced start',
    async (initial) => {
      state = initial;
      const controller = await hold();
      await controller.prepare(initial);
      await controller.hold();
      await controller.assertHeld();
      await controller.restore();
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled();
      expect(state).toBe(initial);
    },
  );
  it('does not mask or stop busy work and can abort unchanged preparation', async () => {
    const controller = await hold();
    await controller.prepare('active');
    admission.mockRejectedValueOnce(new Error('Gateway is busy'));
    await expect(controller.hold(admission)).rejects.toThrow(/busy/);
    expect(await readFile(unit, 'utf8')).toBe(definition);
    expect(service.stop).not.toHaveBeenCalled();
    await controller.restore();
    expect(await readFile(unit, 'utf8')).toBe(definition);
  });
  it('refuses stale/insufficient admission immediately before stop, retaining an inspectable hold', async () => {
    const controller = await hold();
    await controller.prepare('active');
    admission.mockResolvedValueOnce({ expiresAtMs: Date.now() + 120000 });
    admission.mockResolvedValueOnce({ expiresAtMs: Date.now() + 10 });
    await expect(controller.hold(admission)).rejects.toThrow(/bounded service stop/);
    expect(await readlink(unit)).toBe('/dev/null');
    expect(state).toBe('active');
    expect(service.stop).not.toHaveBeenCalled();
    await expect(controller.assertHeld()).rejects.toThrow(/No completed/);
    await controller.restore();
    expect(state).toBe('active');
  });
  it('adopts a confirmed held result without native calls or another stop', async () => {
    const controller = await hold();
    await controller.prepare('active');
    await controller.hold(admission);
    await controller.hold(admission);
    expect(service.stop).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledTimes(2);
  });
  it('never retries an uncertain stop, while owned abort can restore the source', async () => {
    const controller = await hold();
    await controller.prepare('active');
    vi.mocked(service.stop).mockRejectedValueOnce(new Error('Unknown systemd stop result'));
    await expect(controller.hold(admission)).rejects.toThrow(/Unknown/);
    await expect(controller.hold(admission)).rejects.toThrow(/Partial archive hold/);
    expect(service.stop).toHaveBeenCalledOnce();
    await controller.restore();
    expect(state).toBe('active');
    expect(await readFile(unit, 'utf8')).toBe(definition);
  });
  it('retains data and refuses a changed service definition instead of overwriting it', async () => {
    const controller = await hold();
    await controller.prepare('active');
    await writeFile(unit, 'foreign service definition');
    await expect(controller.hold(admission)).rejects.toThrow(/definition changed/);
    await expect(controller.restore()).rejects.toThrow(/did not overwrite/);
    expect(await readFile(unit, 'utf8')).toBe('foreign service definition');
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });
  it('recovers an interrupted unit move before a mask was installed', async () => {
    const controller = await hold();
    await controller.prepare('active');
    await rename(unit, path.join(work, 'archive-gateway.service'));
    await controller.restore();
    expect(await readFile(unit, 'utf8')).toBe(definition);
    expect(state).toBe('active');
  });
  it('reconciles its two original hard links after interrupted restoration, without replacing another file', async () => {
    const controller = await hold();
    await controller.prepare('active');
    await controller.hold(admission);
    await unlink(unit);
    await link(path.join(work, 'archive-gateway.service'), unit);
    expect((await lstat(unit)).nlink).toBe(2);
    await controller.restore();
    expect((await lstat(unit)).nlink).toBe(1);
    await expect(lstat(path.join(work, 'archive-gateway.service'))).rejects.toThrow();
    expect(await readFile(unit, 'utf8')).toBe(definition);
  });
  it('will not resume or remove a foreign mask, unit, or operation record', async () => {
    const controller = await hold();
    await controller.prepare('active');
    const other = await archiveServiceHold({
      home,
      operationId,
      requestDigest: 'b'.repeat(64),
      service,
    });
    await expect(other.restore()).rejects.toThrow(/ownership/);
    await controller.hold(admission);
    await unlink(unit);
    await writeFile(unit, 'foreign replacement');
    await expect(controller.assertHeld()).rejects.toThrow(/persistent mask/);
    await expect(controller.restore()).rejects.toThrow(/did not overwrite/);
    expect(await readFile(path.join(work, 'archive-gateway.service'), 'utf8')).toBe(definition);
    expect(service.start).not.toHaveBeenCalled();
  });
  it('does not infer completed restoration from a historical receipt after the service changes', async () => {
    const controller = await hold();
    await controller.prepare('active');
    await controller.hold(admission);
    await controller.restore();
    state = 'inactive';
    await expect(controller.restore()).rejects.toThrow(/not restored/);
    expect(service.start).toHaveBeenCalledOnce();
  });
});
