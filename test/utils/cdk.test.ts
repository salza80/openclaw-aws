import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
const resolveDependency = vi.hoisted(() => vi.fn());
vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: resolveDependency }),
}));
import { getCDKBinary, getCDKAppCommand, withCDKWorkspace } from '../../src/cli/utils/cdk.js';

describe('getCDKBinary', () => {
  beforeEach(() => {
    resolveDependency.mockReset().mockImplementation(() => {
      throw new Error('not installed');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds a hoisted dependency instead of using an unrelated global CLI', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    resolveDependency.mockReturnValue('/consumer/node_modules/aws-cdk/package.json');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => String(p) === '/consumer/node_modules/aws-cdk/bin/cdk',
    );
    expect(getCDKBinary()).toBe('/consumer/node_modules/aws-cdk/bin/cdk');
    expect(resolveDependency).toHaveBeenCalledWith('aws-cdk/package.json');
  });

  it('returns cdk.cmd on Windows when present', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const normalized = path.normalize(String(p));
      return normalized.endsWith(path.join('node_modules', '.bin', 'cdk.cmd'));
    });

    const result = getCDKBinary();
    expect(result.endsWith(path.join('node_modules', '.bin', 'cdk.cmd'))).toBe(true);

    platformSpy.mockRestore();
    existsSpy.mockRestore();
  });

  it('returns cdk.ps1 on Windows when cmd is missing', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const normalized = path.normalize(String(p));
      return normalized.endsWith(path.join('node_modules', '.bin', 'cdk.ps1'));
    });

    const result = getCDKBinary();
    expect(result.endsWith(path.join('node_modules', '.bin', 'cdk.ps1'))).toBe(true);

    platformSpy.mockRestore();
    existsSpy.mockRestore();
  });

  it('returns local cdk on non-Windows when present', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const normalized = path.normalize(String(p));
      return normalized.endsWith(path.join('node_modules', '.bin', 'cdk'));
    });

    const result = getCDKBinary();
    expect(result.endsWith(path.join('node_modules', '.bin', 'cdk'))).toBe(true);

    platformSpy.mockRestore();
    existsSpy.mockRestore();
  });

  it('falls back to global cdk when local is missing', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = getCDKBinary();
    expect(result).toBe('cdk');

    platformSpy.mockRestore();
    existsSpy.mockRestore();
  });
});

it('quotes installed app paths containing spaces and shell metacharacters', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const command = getCDKAppCommand("/a folder/$(false)/it's/app.js");
  expect(command).toContain('"/a folder/\\$(false)/it\'s/app.js"');
});

it('isolates concurrent CDK workspaces and cleans them after success or failure', async () => {
  const directories: string[] = [];
  await Promise.all(
    [1, 2].map(() =>
      withCDKWorkspace({ HOME: '/original' }, async ({ cwd, env }) => {
        directories.push(cwd);
        expect(env.HOME).toBe(cwd);
        expect(fs.existsSync(cwd)).toBe(true);
        await Promise.resolve();
      }),
    ),
  );
  expect(new Set(directories).size).toBe(2);
  for (const directory of directories) expect(fs.existsSync(directory)).toBe(false);
  let failedDirectory = '';
  await expect(
    withCDKWorkspace({}, async ({ cwd }) => {
      failedDirectory = cwd;
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(fs.existsSync(failedDirectory)).toBe(false);
});
