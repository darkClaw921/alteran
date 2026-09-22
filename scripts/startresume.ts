/** Start with --resume <id> and confirm the transcript is on screen. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';
import { projectSlug } from '../src/config/paths.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
process.env.ALTERAN_HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-start-'));
const sdir = path.join(home, 'sessions', projectSlug(dir));
fs.mkdirSync(sdir, { recursive: true });
const id = '21e5d0e1-0000-0000-0000-000000000000';
fs.writeFileSync(
  path.join(sdir, `${id}.jsonl`),
  [
    JSON.stringify({ type: 'meta', id, cwd: dir, root: dir, model: 'ollama:test', createdAt: new Date().toISOString(), title: 'починить парсер' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'починить парсер конфигурации' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Готово: парсер больше не падает на пустых секциях.' }] } }),
  ].join('\n') + '\n',
);

const { io } = await launch({ cwd: dir, model: 'ollama:test', resume: '21e5d0e1' }, 110, 28);
await sleep(900);
console.log(io.screen().split('\n').slice(-16).join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
