import { vi } from 'vitest';

type ErrorsModule = typeof import('../../../src/cli/utils/errors.js');

export async function createErrorsModuleMock(
  overrides: Partial<ErrorsModule> = {},
): Promise<ErrorsModule> {
  const actual = await vi.importActual<ErrorsModule>('../../../src/cli/utils/errors.js');
  return {
    ...actual,
    ...overrides,
  };
}

export async function passthroughWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}
