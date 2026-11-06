import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { parseBackupJob } from './backup-contract.js';
import { runCaptureWorker, runArchiveCaptureAction } from './capture-worker.js';

// This process is launched through SSM. All native diagnostics stay in private
// redirected files; only a deliberately small result file is returned to SSM.
async function main() {
  const [mode, inputFile, resultFile] = process.argv.slice(2);
  const actions = ['inspect', 'abort', 'commit'] as const;
  const action = actions.find((action) =>
    ['--lock-archive-' + action, '--archive-' + action].includes(mode),
  );
  if (
    (!['--lock', '--run'].includes(mode) && !action) ||
    !inputFile ||
    !resultFile ||
    process.argv.length !== 5
  )
    throw new Error('Invalid capture worker invocation');
  const file = await open(inputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('Invalid capture job file');
    input = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  const job = parseBackupJob(input);
  const root = path.join(homedir(), '.openclaw-aws');
  const work = path.join(root, 'jobs', job.operationId);
  if (
    path.resolve(inputFile) !== path.join(work, 'request.json') ||
    path.resolve(resultFile) !== path.join(work, 'result.json')
  )
    throw new Error('Capture job files are outside the private operation directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.mode & 0o077 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error('Capture management directory is not private');
  if (mode === '--lock' || mode.startsWith('--lock-archive-')) {
    await execa(
      'flock',
      [
        '--nonblock',
        '--conflict-exit-code',
        '75',
        path.join(root, 'host.lock'),
        process.execPath,
        process.argv[1],
        action ? '--archive-' + action : '--run',
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
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(40 * 60 * 1000)]);
    const result = action
      ? await runArchiveCaptureAction(job, action, signal)
      : await runCaptureWorker(job, signal);
    await writeFile(resultFile, JSON.stringify({ ok: true, ...result }), { mode: 0o600 });
  } catch {
    await writeFile(
      resultFile,
      JSON.stringify({
        ok: false,
        operationId: job.operationId,
        message:
          'Capture failed; source and retained recovery state require inspection before retrying.',
      }),
      { mode: 0o600 },
    );
    process.exitCode = 1;
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
