/** Visual check of the console-only layout (ctrl+b). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-bare-'));
const { io } = await launch({ cwd: dir, mode: 'acceptEdits' }, 150, 32);
await sleep(1200);
for (const ch of '/status') io.key(ch);
await sleep(300);
io.key('\r');
await sleep(800);
console.log('--- default (console only) ---\n' + io.screen());
io.key('\u0002');
await sleep(600);
console.log('--- with panels (^B) ---\n' + io.screen());
io.key('\u0003');
io.key('\u0003');
await sleep(200);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
