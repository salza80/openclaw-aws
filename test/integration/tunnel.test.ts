import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseLocalPort, startDashboardTunnel } from '../../src/aws/tunnel.js';
import { testTarget } from '../helpers/fixtures/command-context.js';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function target(script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-tunnel-'));
  directories.push(directory);
  const binary = path.join(directory, 'aws');
  fs.writeFileSync(binary, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return {
    ...testTarget,
    environment: async () => ({
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    }),
  };
}
describe('real local tunnel processes (no AWS calls)', () => {
  it('keeps two child-owned tunnels open independently', async () => {
    const fake = target(`const net=require('node:net');
      const params=JSON.parse(process.argv[process.argv.indexOf('--parameters')+1]);
      const port=Number(params.localPortNumber[0]);
      const server=net.createServer(socket=>socket.end('ok'));
      server.on('error',()=>process.exit(2));
      server.listen(port,'127.0.0.1',()=>console.log('Port '+port+' opened for sessionId test.'));
      process.on('SIGINT',()=>server.close(()=>process.exit(0)));`);
    const [alpha, beta] = await Promise.all([
      startDashboardTunnel({ instanceId: 'i-alpha', target: fake }),
      startDashboardTunnel({ instanceId: 'i-beta', target: fake }),
    ]);
    try {
      expect(alpha.port).not.toBe(beta.port);
      for (const tunnel of [alpha, beta])
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(tunnel.port, '127.0.0.1');
          socket.on('error', reject);
          socket.on('data', (data) => {
            expect(data.toString()).toBe('ok');
            socket.destroy();
            resolve();
          });
        });
    } finally {
      alpha.stop();
      beta.stop();
      await Promise.all([alpha.done, beta.done]);
    }
  });
  it('rejects an occupied requested port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as net.AddressInfo;
      await expect(chooseLocalPort(address.port)).rejects.toThrow('unavailable');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('does not mistake another listener for child readiness when the child fails', async () => {
    const fake = target('process.exit(1)');
    await expect(startDashboardTunnel({ instanceId: 'i-alpha', target: fake })).rejects.toThrow(
      'process failed',
    );
  });
});
