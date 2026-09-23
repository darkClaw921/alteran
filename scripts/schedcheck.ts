import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep, untilScreen } from '../test/harness.js';

/** Drive /schedule through the fake terminal and print the left panel that shows it. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-sched-home-'));
process.env.ALTERAN_HOME = home;
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ panels: true, intro: false }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-sched-'));

const { io } = await launch({ cwd: dir, mode: 'autonomous' }, 200, 44);
for (const ch of '/schedule 10m re-run the test suite') io.key(ch);
// Ink batches keystrokes that arrive in one chunk, so Enter needs a tick of its own.
await sleep(400);
io.key('\r');
await sleep(800);
for (const ch of '/schedule 45s open the PR') io.key(ch);
await sleep(200);
io.key('\r');
await untilScreen(io, 's2');
console.log(io.screen().split('\n').slice(-44).join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
