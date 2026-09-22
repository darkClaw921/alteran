/**
 * Worker-thread entry for the boot animation (see `playInWorker` in intro.ts): renders frames and
 * writes them straight to the terminal, so a busy main thread cannot make the picture stutter.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { runIntro, type IntroWorkerData } from './intro.js';
import { applyTheme } from './theme.js';

const data = workerData as IntroWorkerData;
applyTheme(data.theme);
let size: [number, number] = [data.cols, data.rows];
let ready = false;
parentPort!.on('message', (m: { type: string; cols?: number; rows?: number }) => {
  if (m.type === 'ready') ready = true;
  if (m.type === 'size' && m.cols && m.rows) size = [m.cols, m.rows];
});

function write(s: string) {
  const buf = Buffer.from(s);
  for (let off = 0; off < buf.length; ) {
    try {
      off += fs.writeSync(data.fd, buf, off);
    } catch (e) {
      // A non-blocking terminal that is momentarily full: try again.
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
    }
  }
}

await runIntro({ write, size: () => size, ready: () => ready });
parentPort!.postMessage({ type: 'done' });
