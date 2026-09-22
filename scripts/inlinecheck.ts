/** Inline layout: settled entries must be written once and never redrawn. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-inline-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 100, 24);
await sleep(700);
for (const cmd of ['/status', '/iris']) {
  io.key(cmd);
  await sleep(150);
  io.key('\r');
  await sleep(400);
}
await sleep(400);
console.log('--- after two commands ---\n' + io.text().split('\n').slice(-22).join('\n'));
io.clear();
await sleep(1200);
const redrawn = io.text();
console.log('--- written during the next 1.2s (should be the live area only) ---');
console.log(JSON.stringify(redrawn.slice(0, 400)));
console.log('contains old output:', redrawn.includes('Session:'), redrawn.includes('Allow rules:'));
process.exit(0);
