import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', abr: 'src/abr.ts', 'intro-worker': 'src/tui/intro-worker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: true,
  banner: { js: '#!/usr/bin/env node' },
  loader: { '.md': 'text' },
});
