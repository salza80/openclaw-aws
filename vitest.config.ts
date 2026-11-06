import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Native fixtures each launch several OpenClaw processes. Serialize files
    // on shared CI runners so CPU contention does not consume their budgets.
    fileParallelism: !process.env.CI,
    coverage: {
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      exclude: [
        'src/cdk/**',
        'dist/**',
        'bin/**',
        '**/*.d.ts',
        'eslint.config.js',
        'scripts/**',
        'src/cli/types/**',
        'vitest.config.ts',
        'jest.config.js',
      ],
    },
  },
});
