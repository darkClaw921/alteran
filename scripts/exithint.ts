/** Show the exit hint exactly as it is printed after the TUI closes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from '../test/harness.js';
import { projectSlug } from '../src/config/paths.js';
import { setColorEnabled } from '../src/util/color.js';

setColorEnabled(true);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
process.env.ALTERAN_HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-exit-'));
const sdir = path.join(home, 'sessions', projectSlug(dir));
fs.mkdirSync(sdir, { recursive: true });
for (const id of ['aaaaaaaa-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000000']) {
  fs.writeFileSync(
    path.join(sdir, `${id}.jsonl`),
    [
      JSON.stringify({ type: 'meta', id, cwd: dir, root: dir, model: 'ollama:test', createdAt: new Date().toISOString(), title: 'older work' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'older work' }] } }),
    ].join('\n') + '\n',
  );
}
const { io, done } = await launch({ cwd: dir, model: 'ollama:test' }, 100, 28);
await sleep(600);
io.key('\u0003');
await sleep(300);
io.key('\u0003');
await done;
const screen = io.screen();
console.log(screen.slice(screen.indexOf('Nothing was sent') - 1));
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
