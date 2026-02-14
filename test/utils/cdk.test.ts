import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getCDKBinary } from '../../src/cli/utils/cdk.js';

describe('getCDKBinary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
