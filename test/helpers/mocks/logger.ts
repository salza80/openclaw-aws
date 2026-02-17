import { vi } from 'vitest';

export function createLoggerMock() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    title: vi.fn(),
    box: vi.fn(),
  };
}
