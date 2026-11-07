import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    // Test files share one PostgreSQL database; run them one file at a time so
    // expiry-processing tests cannot interfere with other files' timing.
    // Inside a file, concurrency tests still use truly parallel DB connections.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
