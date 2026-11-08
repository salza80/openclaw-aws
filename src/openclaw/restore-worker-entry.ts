import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { parseRestoreJob } from './restore-contract.js';
import { runRestoreWorker } from './restore-worker.js';
import { runRestoreActivation } from './restore-activation.js';
import { parseClonePreviewRequest, previewCloneStaging } from './clone-preview.js';
import { parseCloneJob } from './clone-contract.js';
import { runCloneWorker } from './clone-worker.js';
import { runCloneActivation } from './clone-activation.js';
import { RecoveryActivationFailure } from './recovery-service.js';

async function main() {
  const [mode, inputFile, resultFile] = process.argv.slice(2);
  if (
    ![
      '--lock',
      '--run',
      '--lock-activate',
      '--activate',
      '--preview-clone',
      '--lock-clone',
      '--run-clone',
      '--lock-activate-clone',
      '--activate-clone',
    ].includes(mode) ||
    !inputFile ||
    !resultFile ||
    process.argv.length !== 5
  )
    throw new Error('Invalid restore worker invocation');
  const file = await open(inputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 1024 * 1024 ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error('Restore request file is not private');
    input = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  if (mode === '--preview-clone') {
    if (path.dirname(path.resolve(inputFile)) !== path.dirname(path.resolve(resultFile)))
      throw new Error('Clone preview files must share a private operation directory');
    const directory = await lstat(path.dirname(path.resolve(inputFile)));
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077
    )
      throw new Error('Clone preview directory is not private');
    const cancellation = new AbortController();
    process.once('SIGTERM', () => cancellation.abort());
    process.once('SIGINT', () => cancellation.abort());
    const result = await previewCloneStaging(
      parseClonePreviewRequest(input),
      AbortSignal.any([cancellation.signal, AbortSignal.timeout(10 * 60 * 1000)]),
    );
    await writeFile(resultFile, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    return;
  }
  const clone = [
    '--lock-clone',
    '--run-clone',
    '--lock-activate-clone',
    '--activate-clone',
  ].includes(mode);
  const job = clone ? parseCloneJob(input) : parseRestoreJob(input);
  const root = path.join(homedir(), '.openclaw-aws');
  const work = path.join(root, 'jobs', job.bootstrap.operationId);
  if (
    path.resolve(inputFile) !== path.join(work, 'request.json') ||
    path.resolve(resultFile) !== path.join(work, 'result.json')
  )
    throw new Error('Restore files are outside the owned operation directory');
  for (const directory of [root, path.join(root, 'jobs'), work, job.pluginDirectory]) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error('Restore operation directory is not private');
  }
  if (
    mode === '--lock' ||
    mode === '--lock-activate' ||
    mode === '--lock-clone' ||
    mode === '--lock-activate-clone'
  ) {
    await execa(
      'flock',
      [
        '--nonblock',
        '--conflict-exit-code',
        '75',
        path.join(root, 'host.lock'),
        process.execPath,
        process.argv[1],
        mode === '--lock-activate-clone'
          ? '--activate-clone'
          : mode === '--lock-activate'
            ? '--activate'
            : clone
              ? '--run-clone'
              : '--run',
        inputFile,
        resultFile,
      ],
      { timeout: 44 * 60 * 1000, forceKillAfterDelay: 150000, maxBuffer: 1024 * 1024 },
    );
    return;
  }
  try {
    const cancellation = new AbortController();
    process.once('SIGTERM', () => cancellation.abort());
    process.once('SIGINT', () => cancellation.abort());
    const run = mode === '--activate' ? runRestoreActivation : runRestoreWorker;
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(40 * 60 * 1000)]);
    const result = clone
      ? await (mode === '--activate-clone' ? runCloneActivation : runCloneWorker)(
          parseCloneJob(job),
          signal,
        )
      : await run(job, signal);
    await writeFile(resultFile, JSON.stringify({ ok: true, ...result }), { mode: 0o600 });
  } catch (error) {
    await writeFile(
      resultFile,
      JSON.stringify({
        ok: false,
        operationId: job.bootstrap.operationId,
        ...(error instanceof RecoveryActivationFailure
          ? {
              activationFailure: {
                phase: error.phase,
                inactiveVerified: error.inactiveVerified,
                ...(error.nativeCategory ? { nativeCategory: error.nativeCategory } : {}),
              },
            }
          : {}),
        message:
          mode === '--activate' || mode === '--activate-clone'
            ? 'Recovery activation failed; Gateway inactivity is unconfirmed. Inspect the target immediately and retain its owned maintenance records and resources.'
            : 'Recovery staging failed; activation was not requested. Inspect the owned maintenance record, staging and retained resources before retrying.',
      }),
      { mode: 0o600 },
    );
    process.exitCode = 1;
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
