import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Pick up TEST_DATABASE_URL from the repo .env when run outside docker.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    // Shared with the db and api suites: creates `lomi_test` if missing and applies migrations.
    globalSetup: ['./src/testing.global-setup.ts'],
    // All suites share one database, so files must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
