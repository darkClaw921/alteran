/** Render the left ASTRIA PORTA panel at full width to check the gate shape. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
process.env.ALTERAN_HOME = home;
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ panels: true }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-panel-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 200, 46);
await sleep(1200);
console.log(
  io
    .screen()
    .split('\n')
    .slice(0, 24)
    .map((l) => l.slice(0, 48))
    .join('\n'),
);
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
