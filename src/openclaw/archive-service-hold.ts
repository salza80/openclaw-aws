import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readlink, rename, symlink, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execa } from 'execa';
import { assertDirectoryChain } from './restore-layout.js';
import { createPrivateControlRecord, privateModelJson } from './model-journal.js';

export interface ArchiveService {
  inspect(): Promise<{ state: 'active' | 'inactive' | 'failed'; masked: boolean }>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  /** Start the original service and verify authenticated native readiness. */
  start(): Promise<void>;
}
type UnitIdentity = { sha256: string; device: string; inode: string; mode: number };
type HoldRecord = {
  schemaVersion: 1;
  operationId: string;
  requestDigest: string;
  initial: 'active' | 'inactive' | 'failed';
  unit: UnitIdentity;
};
const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function syncDirectory(directory: string) {
  const file = await open(directory, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readUnit(filename: string, links = 1): Promise<UnitIdentity | undefined> {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.uid !== BigInt(process.getuid!()) ||
      info.nlink < 1n ||
      info.nlink > BigInt(links) ||
      Number(info.mode) & 0o022 ||
      info.size > 128n * 1024n
    )
      throw new Error('Archive Gateway service definition has unsupported ownership');
    return {
      sha256: digest(await file.readFile()),
      device: String(info.dev),
      inode: String(info.ino),
      mode: Number(info.mode) & 0o777,
    };
  } finally {
    await file.close();
  }
}

/** Uses the original service definition. The caller supplies the existing
 * authenticated start/readiness path; no fresh native installation is run.
 */
export function systemdArchiveService(start: () => Promise<void>): ArchiveService {
  const run = async (args: string[], timeout: number) => {
    try {
      return await execa('systemctl', ['--user', ...args], { timeout, maxBuffer: 65536 });
    } catch {
      throw new Error('Archive service action was not confirmed; inspect the owned hold');
    }
  };
  return {
    async inspect() {
      const response = await run(
        ['show', 'openclaw-gateway.service', '--property=ActiveState', '--property=LoadState'],
        10000,
      );
      const fields = Object.fromEntries(response.stdout.split('\n').map((line) => line.split('=')));
      if (
        !['active', 'inactive', 'failed'].includes(fields.ActiveState) ||
        !['loaded', 'masked'].includes(fields.LoadState)
      )
        throw new Error('Gateway service is transitioning or has unsupported ownership');
      return {
        state: fields.ActiveState as 'active' | 'inactive' | 'failed',
        masked: fields.LoadState === 'masked',
      };
    },
    async reload() {
      await run(['daemon-reload'], 10000);
    },
    async stop() {
      await run(['stop', 'openclaw-gateway.service'], 20000);
    },
    start,
  };
}

/** All methods require the host flock and this operation's maintenance record.
 * A persistent /dev/null mask keeps the captured source inactive across reboot.
 * Append-only intent records precede service/file changes. Partial hold creation
 * requires inspection/owned abort, never an automatic second capture attempt.
 */
export async function archiveServiceHold(options: {
  home: string;
  operationId: string;
  requestDigest: string;
  service: ArchiveService;
}) {
  const { home, operationId, requestDigest, service } = options;
  if (
    !path.isAbsolute(home) ||
    path.resolve(home) !== home ||
    home === '/' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId) ||
    !/^[a-f0-9]{64}$/.test(requestDigest) ||
    !process.getuid ||
    process.getuid() === 0
  )
    throw new Error('Archive service hold requires a canonical unprivileged operation');
  const root = path.join(home, '.openclaw-aws');
  const work = path.join(root, 'jobs', operationId);
  const unit = path.join(home, '.config/systemd/user/openclaw-gateway.service');
  const saved = path.join(work, 'archive-gateway.service');
  await assertDirectoryChain(work, home, true);
  await assertDirectoryChain(path.dirname(unit), home, false);
  for (const directory of [root, path.join(root, 'jobs'), work])
    if ((await lstat(directory)).mode & 0o077)
      throw new Error('Archive service hold directory must be private');
  if ((await lstat(work)).dev !== (await lstat(path.dirname(unit))).dev)
    throw new Error('Archive service hold requires one source filesystem');
  const owner = { schemaVersion: 1, operationId, requestDigest };
  const read = async (name: string) => {
    try {
      return await privateModelJson(path.join(work, name));
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
  };
  const savedExists = async () => {
    try {
      await lstat(saved);
      return true;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  };
  const mark = async (name: string) => {
    try {
      await createPrivateControlRecord(path.join(work, name), owner);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (!isDeepStrictEqual(await read(name), owner))
        throw new Error('Archive service transition belongs to another request', { cause: error });
    }
  };
  const record = async (): Promise<HoldRecord> => {
    const value = await read('archive-service.json');
    const expected = value?.unit as UnitIdentity | undefined;
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.operationId !== operationId ||
      value.requestDigest !== requestDigest ||
      !['active', 'inactive', 'failed'].includes(String(value.initial)) ||
      !expected ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !/^\d+$/.test(expected.device) ||
      !/^\d+$/.test(expected.inode) ||
      !Number.isInteger(expected.mode) ||
      expected.mode < 0 ||
      expected.mode > 0o777 ||
      expected.mode & 0o022
    )
      throw new Error('Archive service record has different or unsupported ownership');
    return value as unknown as HoldRecord;
  };
  const original = async (filename: string, links = 1) => {
    const expected = (await record()).unit;
    if (!isDeepStrictEqual(await readUnit(filename, links), expected))
      throw new Error('Original Gateway service definition changed; it was retained');
  };
  const masked = async () => {
    const info = await lstat(unit);
    if (
      !info.isSymbolicLink() ||
      info.uid !== process.getuid!() ||
      (await readlink(unit)) !== '/dev/null'
    )
      throw new Error('Gateway service is not held by the expected persistent mask');
  };
  const inactive = async () => {
    await masked();
    await original(saved);
    const actual = await service.inspect();
    if (!actual.masked || actual.state === 'active')
      throw new Error('Gateway inactivity is unconfirmed; capture or deletion is refused');
  };
  return {
    async prepare(initial: HoldRecord['initial']) {
      if (!['active', 'inactive', 'failed'].includes(initial))
        throw new Error('Unsupported original Gateway service state');
      if (await read('archive-service.json')) {
        const prior = await record();
        if (prior.initial !== initial)
          throw new Error('Archive initial service state changed before preparation');
        return;
      }
      const current = await service.inspect();
      if (current.masked || current.state !== initial || (await savedExists()))
        throw new Error('Archive requires an unchanged, unmasked original service');
      const definition = await readUnit(unit);
      if (!definition) throw new Error('Original Gateway service definition is missing');
      await createPrivateControlRecord(path.join(work, 'archive-service.json'), {
        ...owner,
        initial,
        unit: definition,
      });
    },
    async hold(verifyAdmission?: () => Promise<{ expiresAtMs: number }>) {
      const prior = await record();
      if (await read('archive-service-restore-intent.json'))
        throw new Error('Archive service restoration already began; delayed hold was refused');
      if (await read('archive-service-held.json')) {
        await mark('archive-service-held.json');
        await inactive();
        return;
      }
      if (await read('archive-service-hold-intent.json'))
        throw new Error('Partial archive hold requires inspection or owned abort');
      const admission = async () => {
        if (prior.initial !== 'active') {
          if ((await service.inspect()).state === 'active')
            throw new Error('Previously inactive Gateway is now active; archive was refused');
          return;
        }
        if (!verifyAdmission) throw new Error('Active Gateway needs native idle/ownership proof');
        const checked = await verifyAdmission();
        if (!Number.isSafeInteger(checked.expiresAtMs) || checked.expiresAtMs - Date.now() < 30000)
          throw new Error('Native idle lease cannot cover the bounded service stop');
      };
      await admission();
      await original(unit);
      await mark('archive-service-hold-intent.json');
      await rename(unit, saved);
      await syncDirectory(path.dirname(unit));
      await syncDirectory(work);
      await original(saved);
      await symlink('/dev/null', unit);
      await syncDirectory(path.dirname(unit));
      await service.reload();
      await admission();
      if (prior.initial === 'active') await service.stop();
      await inactive();
      await mark('archive-service-held.json');
    },
    async assertHeld() {
      await record();
      if (await read('archive-service-restore-intent.json'))
        throw new Error('Archive hold is being restored; destruction is refused');
      if (!(await read('archive-service-held.json')))
        throw new Error('No completed archive service hold exists');
      await mark('archive-service-held.json');
      await inactive();
    },
    async restore() {
      const prior = await record();
      await mark('archive-service-restore-intent.json');
      // Linking publishes the complete original without overwriting a foreign
      // unit. Two links are owned only during interrupted restoration.
      let current;
      try {
        const info = await lstat(unit);
        if (info.isSymbolicLink()) {
          await masked();
          await original(saved);
          await unlink(unit);
          await syncDirectory(path.dirname(unit));
        } else current = await readUnit(unit, 2);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (current && !isDeepStrictEqual(current, prior.unit))
        throw new Error('Gateway service changed; archive did not overwrite it');
      if (!current) {
        await original(saved);
        await link(saved, unit);
        await syncDirectory(path.dirname(unit));
      }
      await original(unit, 2);
      const retained = await readUnit(saved, 2);
      if (retained) {
        if (!isDeepStrictEqual(retained, prior.unit))
          throw new Error('Saved Gateway definition changed; it was retained');
        await unlink(saved);
        await syncDirectory(work);
      }
      await service.reload();
      if (prior.initial === 'active' && !(await read('archive-service-restored.json')))
        await service.start();
      const actual = await service.inspect();
      if (
        actual.masked ||
        (prior.initial === 'active' ? actual.state !== 'active' : actual.state === 'active')
      )
        throw new Error('Prior Gateway state was not restored; maintenance ownership remains');
      await mark('archive-service-restored.json');
    },
  };
}
