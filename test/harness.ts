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
  // `interactive: true` matters on CI: Ink otherwise treats the run as non-interactive and holds
  // every frame back until unmount, so the fake terminal stays empty for the whole test.
  const done = startTui({ ...opts, mcp: false }, { stdin: io.stdin as NodeJS.ReadStream, stdout: io.stdout as NodeJS.WriteStream, interactive: true });
  await new Promise((r) => setTimeout(r, 400));
  return { io, done };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `probe` returns a value — fixed sleeps race on slow runners, where the first paint
 * lands much later than on a laptop. Presence assertions must still hold within `timeout`.
 */
export async function until<T>(probe: () => T | undefined | false | '', timeout = 10_000, step = 40): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() >= deadline) throw new Error(`condition still unmet after ${timeout}ms`);
    await sleep(step);
  }
}

/** Wait for `needle` in the last rendered screen (panel layout) and return that screen. */
export const untilScreen = (io: { screen: () => string }, needle: string, timeout = 10_000) =>
  until(() => (io.screen().includes(needle) ? io.screen() : undefined), timeout);

/** Wait for `needle` in everything written since the last clear() (inline layout). */
export const untilText = (io: { text: () => string }, needle: string, timeout = 10_000) =>
  until(() => (io.text().includes(needle) ? io.text() : undefined), timeout);
