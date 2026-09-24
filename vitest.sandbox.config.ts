import { defineConfig } from 'vitest/config';

/** The sandbox suite only: real commands, real timers, run inside the throwaway container. */
export default defineConfig({
  test: { include: ['test/sandbox/**/*.test.ts'], testTimeout: 30000 },
});
