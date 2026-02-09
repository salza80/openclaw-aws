import { describe, it, expect } from 'vitest';
import { awsCredentialSuggestions, configNotFoundSuggestions } from '../../src/cli/utils/suggestions.js';

describe('suggestions', () => {
  it('includes SSO login guidance for credentials', () => {
    const suggestions = awsCredentialSuggestions();
    expect(suggestions.some(s => s.includes('aws sso login'))).toBe(true);
  });

  it('includes init guidance for missing config', () => {
    const suggestions = configNotFoundSuggestions();
    expect(suggestions.some(s => s.includes('openclaw-aws init'))).toBe(true);
  });
});
