/** Inline layout must write nothing at all while idle. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-idle-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 100, 24);
await sleep(900);
io.clear();
await sleep(700);
console.log('start screen, before the first prompt:', io.text().length, 'bytes');
io.key('/mode default');
await sleep(150);
io.key('\r');
await sleep(150);
io.key('\r');
await sleep(700);
io.clear();
await sleep(1500);
console.log('bytes written while idle:', io.text().length);

process.exit(0);
