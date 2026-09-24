import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The sandbox suite runs real commands and belongs in the container (`pnpm test:sandbox`).
  test: { include: ['test/**/*.test.ts'], exclude: ['test/sandbox/**'], testTimeout: 20000 },
});
