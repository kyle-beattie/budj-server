import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share a database; keep them off each other's toes.
    fileParallelism: false,
  },
});
