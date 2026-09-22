/** Toggle the help overlay and confirm the transcript stays put. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-help-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 120, 34);
await sleep(800);
io.key('?');
await sleep(400);
console.log('--- help open ---\n' + io.screen().split('\n').slice(-22).join('\n'));
io.key('\u001b[B');
io.key('\u001b[B');
await sleep(300);
console.log('--- scrolled ---\n' + io.screen().split('\n').slice(-6).join('\n'));
io.key('?');
await sleep(400);
console.log('--- closed ---\n' + io.screen().split('\n').slice(-6).join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
