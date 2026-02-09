import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TestWorkspace {
  cwd: string;
  cleanup: () => void;
}

export function createWorkspace(prefix: string = 'openclaw-aws-'): TestWorkspace {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return { cwd, cleanup };
}
