import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-live-'));
fs.writeFileSync(path.join(dir, 'math.js'), 'export const add=(a,b)=>a-b;\n');
const { io } = await launch({ cwd: dir, mode: 'autonomous' }, 200, 44);
await sleep(800);
for (const ch of 'Исправь баг в math.js и ответь одним предложением') io.key(ch);
await sleep(200);
io.key('\r');
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  if (!io.screen().includes('esc to interrupt')) break;
}
await sleep(1500);
console.log(io.screen().split('\n').slice(-44).join('\n'));
console.log('\nFILE:', fs.readFileSync(path.join(dir, 'math.js'), 'utf8'));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
