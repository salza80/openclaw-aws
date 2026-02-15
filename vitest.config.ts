import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      exclude: [
        'src/cdk/**',
        'dist/**',
        'bin/**',
        '**/*.d.ts',
        'src/cli/types/**',
        'vitest.config.ts',
        'jest.config.js',
      ],
    },
  },
});
