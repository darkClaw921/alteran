import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-wheel-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 100, 20);
await sleep(700);
for (let i = 0; i < 12; i++) {
  io.key(`/mode line${i}`);
  await sleep(60);
  io.key('\r');
  await sleep(60);
}
await sleep(600);
console.log('--- bottom ---\n' + io.screen());
for (let i = 0; i < 30; i++) {
  io.key('\u001b[<64;10;10M');
  await sleep(20);
}
await sleep(400);
console.log('--- after wheel up ---\n' + io.screen());
process.exit(0);
