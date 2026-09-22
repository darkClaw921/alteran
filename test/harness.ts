import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startTui, type TuiOptions } from '../src/tui/app.js';

/** Fake TTY streams so the full TUI can be driven in tests. */
export function makeIo(columns = 200, rows = 44) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  let buffer = '';
  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true,
    columns,
    rows,
    write(s: string) {
      buffer += s;
      return true;
    },
  });
  return {
    stdin,
    stdout,
    key: (s: string) => (stdin as unknown as PassThrough).write(s),
    /** Last rendered screen, ANSI stripped. */
    screen: () => {
      const clean = buffer.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
      const marker = '== ANCIENT GATE NETWORK';
      const at = clean.lastIndexOf(marker);
      if (at < 0) return clean;
      // Back up to the start of the line so the wordmark before the marker is kept.
      return clean.slice(clean.lastIndexOf('\n', at) + 1);
    },
    clear: () => (buffer = ''),
    /** Everything written since the last clear(), ANSI stripped — the inline layout's output. */
    text: () => buffer.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, ''),
  };
}

export async function launch(opts: TuiOptions, columns = 200, rows = 44) {
  const io = makeIo(columns, rows);
  const done = startTui({ ...opts, mcp: false }, { stdin: io.stdin as NodeJS.ReadStream, stdout: io.stdout as NodeJS.WriteStream });
  await new Promise((r) => setTimeout(r, 400));
  return { io, done };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
