/** Show /context in the TUI together with the segmented VIRES meter. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
process.env.ALTERAN_HOME = home;
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ panels: true }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-ctx-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 200, 44);
await sleep(900);
for (const ch of '/context') io.key(ch);
await sleep(300);
io.key('\r');
await sleep(400);
io.key('\r');
await sleep(700);
const rows = io.screen().split('\n');
const vires = rows.findIndex((l) => l.includes('-- VIRES'));
console.log(
  rows
    .slice(vires, vires + 5)
    .map((l) => l.slice(100))
    .join('\n'),
);
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
