import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['./src/testing.global-setup.ts'],
    fileParallelism: false,
  },
});
