import { describe, it, expect } from 'vitest';
import { validateProjectName, validateInstanceName } from '../../src/cli/utils/validation.js';

describe('validation', () => {
  it('accepts valid project names', () => {
    expect(validateProjectName('my-bot')).toBe(true);
    expect(validateProjectName('my-bot-2')).toBe(true);
  });

  it('rejects invalid project names', () => {
    expect(validateProjectName('MyBot')).toBeTypeOf('string');
    expect(validateProjectName('-bad')).toBeTypeOf('string');
    expect(validateProjectName('bad-')).toBeTypeOf('string');
  });

  it('accepts valid instance names', () => {
    expect(validateInstanceName('openclaw-my-bot')).toBe(true);
  });

  it('rejects invalid instance names', () => {
    expect(validateInstanceName('bad name')).toBeTypeOf('string');
  });
});
