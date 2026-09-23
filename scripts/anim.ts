/** Print successive frames of the idle gate animation. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-anim-'));
const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 120, 30);
for (let i = 0; i < 4; i++) {
  await sleep(700);
  console.log(`--- frame ${i} ---`);
  console.log(
    io
      .screen()
      .split('\n')
      .slice(2, 17)
      .map((l) => l.slice(0, 40))
      .join('\n'),
  );
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
