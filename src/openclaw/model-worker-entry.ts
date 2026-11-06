import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { parseModelJob } from './model-contract.js';
import {
  privateModelJson,
  installModelRequest,
  installNativeControlRequest,
} from './model-journal.js';
import { runAwsModelWorker } from './model-host.js';
import type { ModelWorkerMode } from './model-worker.js';
import { assertDirectoryChain } from './restore-layout.js';
import { parseBedrockJob, type BedrockWorkerMode } from './bedrock-contract.js';
import { runAwsBedrockWorker } from './bedrock-host.js';

async function main() {
  const [lock, mode, inputFile] = process.argv.slice(2);
  const provider = lock?.startsWith('--bedrock-') ?? false;
  const step = provider ? lock.replace('--bedrock-', '--') : lock;
  if (
    !['--dispatch', '--lock', '--run'].includes(step) ||
    !(
      provider
        ? ['preview', 'execute', 'inspect', 'accept-configured', 'accept-previous', 'abort']
        : ['execute', 'inspect', 'accept-requested', 'accept-previous']
    ).includes(mode) ||
    !inputFile ||
    process.argv.length !== 5
  )
    throw new Error('Invalid model worker invocation');
  const home = homedir();
  const root = path.join(home, '.openclaw-aws');
  if (home !== '/home/ubuntu' || process.getuid?.() === 0)
    throw new Error('Model dispatch requires the Ubuntu service user');
  if (step === '--dispatch') {
    if (inputFile.length > 16000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(inputFile))
      throw new Error('Invalid bounded model request encoding');
    const decoded = Buffer.from(inputFile, 'base64');
    if (decoded.toString('base64') !== inputFile)
      throw new Error('Noncanonical model request encoding');
    const data = JSON.parse(decoded.toString('utf8'));
    const filename = provider
      ? await installNativeControlRequest(home, 'bedrock-requests', parseBedrockJob(data))
      : await installModelRequest(home, data);
    const result = await execa(
      process.execPath,
      [process.argv[1], provider ? '--bedrock-lock' : '--lock', mode, filename],
      {
        timeout: 15 * 60 * 1000,
        forceKillAfterDelay: 10000,
        maxBuffer: 20000,
      },
    );
    JSON.parse(result.stdout);
    process.stdout.write(result.stdout);
    return;
  }
  const data = await privateModelJson(inputFile);
  const job = provider ? parseBedrockJob(data) : parseModelJob(data);
  if (
    path.resolve(inputFile) !==
    path.join(
      root,
      provider ? 'bedrock-requests' : 'model-requests',
      job.operationId,
      'request.json',
    )
  )
    throw new Error('Model request is outside the owned delivery directory');
  await assertDirectoryChain(path.dirname(inputFile), home, false);
  if (step === '--lock') {
    const file = await open(
      path.join(root, 'host.lock'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.nlink !== 1
      )
        throw new Error('Shared host lock is unsafe');
    } finally {
      await file.close();
    }
    try {
      const result = await execa(
        'flock',
        [
          '--nonblock',
          '--conflict-exit-code',
          '75',
          path.join(root, 'host.lock'),
          process.execPath,
          process.argv[1],
          provider ? '--bedrock-run' : '--run',
          mode,
          inputFile,
        ],
        {
          timeout: 14 * 60 * 1000,
          forceKillAfterDelay: 10000,
          maxBuffer: 20000,
        },
      );
      // The child publishes only the bounded worker projection. Native CLI
      // diagnostics/SDK errors never cross this boundary.
      JSON.parse(result.stdout);
      process.stdout.write(result.stdout);
    } catch {
      throw new Error(
        'Model worker did not complete; inspect the durable operation before retrying',
      );
    }
    return;
  }
  const cancellation = new AbortController();
  process.once('SIGTERM', () => cancellation.abort());
  process.once('SIGINT', () => cancellation.abort());
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(12 * 60 * 1000)]);
  const result = provider
    ? await runAwsBedrockWorker(job, mode as BedrockWorkerMode, signal)
    : await runAwsModelWorker(job, mode as ModelWorkerMode, signal);
  const serialized = JSON.stringify({ ok: true, ...result });
  if (Buffer.byteLength(serialized) > 18000)
    throw new Error('Model result exceeds bounded remote output');
  process.stdout.write(serialized);
}
void main().catch(() => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      message:
        'Model operation failed or was interrupted. Inspect the recorded operation and host maintenance before retrying; private native output was not published.',
    }),
  );
  process.exitCode = 1;
});
