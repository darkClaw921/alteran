/** Write two fake sessions, then open the /resume picker and continue one. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';
import { projectSlug } from '../src/config/paths.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
process.env.ALTERAN_HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-resume-'));
const sdir = path.join(home, 'sessions', projectSlug(dir));
fs.mkdirSync(sdir, { recursive: true });
const session = (id: string, title: string, turns: number) => {
  const lines = [JSON.stringify({ type: 'meta', id, cwd: dir, root: dir, model: 'ollama:test', createdAt: new Date().toISOString(), title })];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `${title} #${i}` }] } }));
    lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
  }
  fs.writeFileSync(path.join(sdir, `${id}.jsonl`), lines.join('\n') + '\n');
};
session('11111111-1111-1111-1111-111111111111', 'исправить парсер конфигурации', 3);
session('22222222-2222-2222-2222-222222222222', 'добавить поддержку webhooks', 7);

const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 130, 34);
await sleep(900);
for (const ch of '/resume') io.key(ch);
await sleep(300);
io.key('\r');
await sleep(600);
console.log('--- picker ---\n' + io.screen());
io.key('\u001b[B');
await sleep(200);
io.key('\r');
await sleep(600);
console.log('--- resumed ---\n' + io.screen().split('\n').slice(-12).join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
