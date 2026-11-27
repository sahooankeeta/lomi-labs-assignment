import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Pick up TEST_DATABASE_URL from the repo .env when run outside docker.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['./src/testing.global-setup.ts'],
    fileParallelism: false,
  },
});
