import net from 'node:net';
import { execa } from 'execa';
import type { AwsTarget } from './target.js';
import { AWSError } from '../cli/utils/errors.js';

export async function chooseLocalPort(requested = 0): Promise<number> {
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535)
    throw new AWSError(
      'Local port must be an integer from 1 to 65535 (or 0 for automatic selection)',
    );
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () =>
      reject(new AWSError(`Local port ${requested} is unavailable; choose another --local-port`)),
    );
    server.listen(requested, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) =>
        error || !port ? reject(error ?? new Error('Missing local port')) : resolve(port),
      );
    });
  });
}

export async function startDashboardTunnel(options: {
  instanceId: string;
  target: AwsTarget;
  localPort?: number;
}) {
  const port = await chooseLocalPort(options.localPort);
  const child = execa(
    'aws',
    [
      'ssm',
      'start-session',
      '--target',
      options.instanceId,
      '--document-name',
      'AWS-StartPortForwardingSession',
      '--parameters',
      JSON.stringify({ portNumber: ['18789'], localPortNumber: [String(port)] }),
      '--region',
      options.target.region,
    ],
    {
      env: await options.target.environment(),
      extendEnv: false,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      forceKillAfterDelay: 3000,
    },
  );
  let ended = false;
  const done = child.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
      throw new AWSError(
        'SSM port-forwarding process failed; check the selected port, AWS session, and Session Manager plugin',
      );
    },
  );
  void done.catch(() => {});
  const stop = () => {
    if (!ended) child.kill('SIGINT');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => finish(new AWSError('Timed out establishing the dashboard tunnel')),
        30000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        if (error) reject(error);
        else resolve();
      };
      const onData = (data: Buffer) => {
        output = (output + data.toString('utf8')).slice(-4096);
        // The plugin prints this only after its own listener has successfully bound.
        // A random localhost listener cannot make this child appear ready.
        if (output.includes(`Port ${port} opened for sessionId `)) finish();
      };
      child.stdout?.on('data', onData);
      child.stderr?.resume();
      void done.then(
        () => finish(new AWSError('Dashboard tunnel exited before it became ready')),
        (error: Error) => finish(error),
      );
    });
    child.stdout?.resume();
    if (ended) throw new AWSError('Dashboard tunnel closed before it became ready');
    return { port, done, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
