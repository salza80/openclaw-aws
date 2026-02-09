import { execa } from 'execa';
import path from 'path';
import { fileURLToPath } from 'url';

export async function runCli(args: string[], cwd: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '../..');
  const cliPath = path.join(repoRoot, 'dist/cli/index.js');
  return execa('node', [cliPath, ...args], { cwd });
}
