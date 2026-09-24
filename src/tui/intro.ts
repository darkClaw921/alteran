/**
 * Boot animation: we fly toward the gate while it dials, the kawoosh bursts out of it, we pass
 * through the event horizon and ride the blue wormhole until the agent is ready.
 *
 * The scene is drawn full screen at whatever size the terminal has, as a tiny pixel shader: every
 * cell is an upper half block whose foreground and background are two square pixels, so the gate
 * stays round. It runs on the alternate screen and leaves no trace in the scrollback.
 *
 * Startup spends a second or two loading settings, extensions and MCP servers; the animation
 * covers that wait. Keep this module light: the CLI starts it before loading the rest of the app.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadSettings } from '../config/settings.js';
import { wantsIntro } from './motion.js';
import { applyTheme, C, type ThemeName } from './theme.js';

export type IntroPhase = 'approach' | 'kawoosh' | 'enter' | 'tunnel' | 'exit';

export interface IntroFrame {
  phase: IntroPhase;
  /** The caption drawn near the bottom, '' when there is none. */
  caption: string;
  /** The whole frame, ready to write: cursor positioning, colours and cells. */
  ansi: string;
}

type RGB = [number, number, number];

/** Seconds each part of the story takes at normal speed. */
const APPROACH = 0.8;
const KAWOOSH = 0.45;
const ENTER = 0.35;
export const TUNNEL_START = APPROACH + KAWOOSH + ENTER;
/** The tunnel shows at least this long, then keeps rushing until the agent is ready. */
const TUNNEL_MIN = 0.25;
const EXIT = 0.25;
/** Once the agent is ready, whatever is left before the tunnel plays this much faster. */
const CATCH_UP = 3;

/** Inner edge of the stone ring, as a fraction of the gate radius. */
const RING_IN = 0.8;
const CHEVRON_ANGLES = Array.from({ length: 9 }, (_, k) => -Math.PI / 2 + (k * 2 * Math.PI) / 9);
/** Deep space → wormhole blue → cyan → white-hot. */
const BLUE: RGB[] = [
  [2, 8, 32],
  [8, 38, 128],
  [22, 100, 220],
  [56, 196, 250],
  [222, 246, 255],
];
const WHITE: RGB = [235, 250, 255];
const STONE: RGB = [120, 100, 76];
const STONE_DARK: RGB = [40, 34, 30];
const CHEVRON_OFF: RGB = [74, 52, 30];

const clamp = (x: number, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
const smooth = (a: number, b: number, x: number) => {
  const q = clamp((x - a) / (b - a));
  return q * q * (3 - 2 * q);
};
const easeOut = (p: number) => 1 - (1 - p) ** 3;
const easeIn = (p: number) => p * p;
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
function ramp(stops: RGB[], x: number): RGB {
  const f = clamp(x) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  return mix(stops[i], stops[i + 1], f - i);
}
const frac = (x: number) => x - Math.floor(x);
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Where the story is: gate size, chevrons, how far the kawoosh reaches, how white the flash is. */
function gateState(t: number) {
  if (t < APPROACH) {
    const p = t / APPROACH;
    return { phase: 'approach' as const, p, radius: 0.18 + 0.44 * easeOut(p), locked: Math.min(9, Math.floor(p * 10.5)), water: 0, burst: 0, flash: 0 };
  }
  if (t < APPROACH + KAWOOSH) {
    const p = (t - APPROACH) / KAWOOSH;
    // The unstable vortex punches out toward us, then falls back into a calm pool.
    const burst = p < 0.45 ? 0.15 + 1.4 * easeOut(p / 0.45) : 1.55 - 0.75 * easeIn((p - 0.45) / 0.55);
    return { phase: 'kawoosh' as const, p, radius: 0.62 + 0.06 * p, locked: 9, water: clamp(p * 3), burst, flash: 0 };
  }
  const p = clamp((t - APPROACH - KAWOOSH) / ENTER);
  // Diving in: the gate grows past the screen edges and the horizon swallows the view.
  return { phase: 'enter' as const, p, radius: 0.68 * 14 ** (p * p), locked: 9, water: 1, burst: 0, flash: smooth(0.6, 1, p) * 0.85 };
}
type GateState = ReturnType<typeof gateState>;

/** Rippling event horizon, `r` in gate radii. */
function horizon(r: number, a: number, x: number, y: number, t: number): RGB {
  const w1 = Math.sin(r * 18 - t * 5 + 0.9 * Math.sin(a * 2 + t) + 0.6 * Math.sin(a * 5 - t * 1.7));
  const w2 = Math.sin(x * 11 + t * 2.3) * Math.sin(y * 11 - t * 1.9);
  const i = 0.42 + 0.2 * w1 + 0.14 * w2 + 0.28 * (1 - r / RING_IN);
  return ramp(BLUE, i);
}

/** The stone ring with its glyph track, lit from the upper left. */
function stone(r: number, a: number, bronze: RGB, rule: RGB): RGB {
  const q = (r - RING_IN) / (1 - RING_IN);
  const bevel = 1 - Math.abs(q * 2 - 1) ** 2;
  const light = 0.7 + 0.3 * Math.cos(a + 2.3);
  let col = scale(mix(STONE_DARK, mix(STONE, bronze, 0.25), bevel), light);
  const around = ((a + Math.PI) / (2 * Math.PI)) * 39;
  if (q > 0.28 && q < 0.72 && hash(Math.floor(around) * 7 + Math.floor((q - 0.28) / 0.11)) < 0.4) col = mix(col, rule, 0.6);
  // Seams between the 39 glyph segments.
  if (Math.abs((around % 1) - 0.5) > 0.44) col = scale(col, 0.65);
  return col;
}

/** A chevron wedge on the rim, or undefined when (r, a) misses all nine. */
function chevron(r: number, a: number, g: GateState, t: number, gold: RGB, amber: RGB): RGB | undefined {
  if (r < 0.84 || r > 1.07) return undefined;
  for (let k = 0; k < 9; k++) {
    let da = a - CHEVRON_ANGLES[k];
    da = Math.atan2(Math.sin(da), Math.cos(da));
    // Wider at the rim, narrowing inward: the V of a chevron.
    const hw = 0.025 + (0.11 * (r - 0.84)) / 0.23;
    const off = Math.abs(da) * r;
    if (off >= hw) continue;
    if (k < g.locked) return mix(gold, WHITE, 0.35 * (1 - off / hw));
    if (k === g.locked && g.phase === 'approach') return mix(CHEVRON_OFF, amber, 0.5 + 0.5 * Math.sin(t * 28));
    return CHEVRON_OFF;
  }
  return undefined;
}

/** Stars streaming past as we close in; brightness per pixel. */
function starField(t: number, w: number, h: number, cx: number, cy: number, unit: number, travelled: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < 260; i++) {
    const sx = (hash(i) * 2 - 1) * 2.4;
    const sy = (hash(i + 500) * 2 - 1) * 2.4;
    const z0 = hash(i + 1000);
    // Three samples along the flight path draw a short streak that lengthens with speed.
    for (let s = 0; s < 3; s++) {
      const depth = 0.08 + 1.6 * frac(z0 - (travelled - s * 0.012 * (1 + t)) * 0.5);
      const x = Math.round(cx + (sx / depth) * 0.35 * unit);
      const y = Math.round(cy + (sy / depth) * 0.35 * unit);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const b = clamp(0.2 + 0.25 / depth) * (1 - s * 0.3);
      if (b > out[y * w + x]) out[y * w + x] = b;
    }
  }
  return out;
}

function gatePixel(u: number, v: number, t: number, g: GateState, star: number, pal: { bg: RGB; bronze: RGB; rule: RGB; gold: RGB; amber: RGB }): RGB {
  const d = Math.hypot(u, v);
  const r = d / g.radius;
  const a = Math.atan2(v, u);
  let col: RGB = star > 0 ? mix(pal.bg, [200, 222, 255], star) : pal.bg;
  if (r < RING_IN) {
    if (g.water > 0) col = mix(col, horizon(r, a, u / g.radius, v / g.radius, t), g.water);
  } else if (r <= 1) {
    col = stone(r, a, pal.bronze, pal.rule);
  }
  const chev = chevron(r, a, g, t, pal.gold, pal.amber);
  if (chev) col = chev;
  if (g.burst > 0 && r < g.burst) {
    const q = r / g.burst;
    const n = 0.6 * Math.sin(r * 16 - t * 25 + 1.2 * Math.sin(a * 9)) + 0.4 * Math.sin(a * 13 + t * 7);
    const surge = ramp(BLUE, 0.55 + 0.3 * (1 - q) + 0.2 * n);
    col = mix(col, surge, smooth(1, 0.8, q) * 0.95);
  }
  if (g.flash > 0) col = mix(col, WHITE, g.flash);
  return col;
}

/** Inside the wormhole: bands and streaks rushing toward us, a light at the far end. */
function tunnelPixel(u: number, v: number, tt: number, exit: number, bg: RGB): RGB {
  const d = Math.hypot(u, v);
  const a = Math.atan2(v, u);
  // Perspective depth: rings further in are further away, and they rush outward past us.
  const z = 1 / (d + 0.05);
  const band = 0.5 + 0.5 * Math.sin(z * 5 + tt * 22 + 0.9 * Math.sin(a * 5 + z * 0.8 - tt * 3));
  const streak = 0.5 + 0.5 * Math.sin(a * 14 + z * 1.6 + tt * 2.5);
  const i = (0.18 + 0.5 * band * band + 0.32 * streak * (0.4 + 0.6 * band)) * (0.2 + 0.8 * smooth(0.02, 0.6, d));
  let col = ramp(BLUE, i);
  const glow = 0.1 + 0.9 * exit * exit;
  col = mix(col, WHITE, Math.exp(-((d / glow) ** 2)) * 0.9);
  // Carry the flash of the horizon over into the tunnel, and fade out to the terminal at the end.
  if (tt < 0.25) col = mix(col, WHITE, (1 - tt / 0.25) * 0.85);
  if (exit > 0.5) col = mix(col, bg, smooth(0.5, 1, exit));
  return col;
}

function captionFor(t: number, g: GateState | undefined, exit: number | undefined): { text: string; color: string } {
  if (exit !== undefined) return { text: '', color: C.cyan };
  if (!g) return { text: 'TRAVERSING', color: C.cyan };
  if (g.phase === 'approach') {
    if (g.locked === 0) return { text: 'DIALING', color: C.muted };
    return g.locked === 9 ? { text: 'CHEVRON 9 LOCKED', color: C.gold } : { text: `CHEVRON ${g.locked} ENCODED`, color: C.gold };
  }
  if (g.phase === 'kawoosh') return { text: 'WORMHOLE ESTABLISHED', color: C.cyan };
  return { text: '', color: C.cyan };
}

/**
 * One frame of the story at `t` seconds, sized to the terminal.
 * `exit` (0..1) runs the arrival at the end of the tunnel; leave it out while still travelling.
 */
export function introFrame(t: number, cols: number, rows: number, exit?: number): IntroFrame {
  const w = Math.max(1, cols);
  const h = Math.max(1, rows);
  const ph = h * 2;
  const unit = Math.max(4, Math.min(w, ph) / 2);
  const cx = w / 2;
  const cy = ph / 2;
  const pal = { bg: rgb(C.bg), bronze: rgb(C.bronze), rule: rgb(C.rule), gold: rgb(C.gold), amber: rgb(C.amber) };

  const inTunnel = t >= TUNNEL_START;
  const g = inTunnel ? undefined : gateState(t);
  const phase: IntroPhase = exit !== undefined ? 'exit' : g ? g.phase : 'tunnel';
  // How far we have flown: follows the growth of the gate so the stars keep pace with it.
  const stars = g ? starField(t, w, ph, cx, cy, unit, 0.25 * t + 1.4 * Math.log(Math.max(g.radius, 0.18) / 0.18)) : undefined;

  const px = new Uint8ClampedArray(w * ph * 3);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5 - cx) / unit;
      const v = (y + 0.5 - cy) / unit;
      const col = g ? gatePixel(u, v, t, g, stars![y * w + x], pal) : tunnelPixel(u, v, t - TUNNEL_START, exit ?? 0, pal.bg);
      const o = (y * w + x) * 3;
      px[o] = col[0];
      px[o + 1] = col[1];
      px[o + 2] = col[2];
    }
  }

  const cap = captionFor(t, g, exit);
  return { phase, caption: cap.text, ansi: encode(px, w, h, cap.text, rgb(cap.color), pal.bg) };
}

/** Pixels → half-block cells, emitting a colour only when it changes. */
function encode(px: Uint8ClampedArray, w: number, h: number, caption: string, captionColor: RGB, plate: RGB): string {
  const capRow = h >= 8 ? h - 3 : -1;
  const capText = caption ? ` ${caption} ` : '';
  const capStart = Math.floor((w - capText.length) / 2);
  // 32 levels per channel: invisible on these gradients, and far fewer colour changes to send.
  const key = (r: number, g: number, b: number) => `${r & 0xf8};${g & 0xf8};${b & 0xf8}`;
  let fg = '';
  let bg = '';
  let out = '';
  // One SGR per cell at most, setting whichever of the two colours changed.
  const paint = (f: string | undefined, b: string) => {
    const codes: string[] = [];
    if (f !== undefined && f !== fg) codes.push(`38;2;${f}`);
    if (b !== bg) codes.push(`48;2;${b}`);
    if (codes.length) out += `\u001b[${codes.join(';')}m`;
    if (f !== undefined) fg = f;
    bg = b;
  };
  for (let y = 0; y < h; y++) {
    out += `\u001b[${y + 1};1H`;
    for (let x = 0; x < w; x++) {
      const ci = x - capStart;
      if (y === capRow && capText && ci >= 0 && ci < capText.length) {
        // Captions sit on a dark plate so they stay readable over the flash.
        paint(key(...captionColor), key(...plate));
        out += (ci === 0 ? '\u001b[1m' : '') + capText[ci] + (ci === capText.length - 1 ? '\u001b[22m' : '');
        continue;
      }
      const top = (y * 2 * w + x) * 3;
      const bot = top + w * 3;
      const t = key(px[top], px[top + 1], px[top + 2]);
      const b = key(px[bot], px[bot + 1], px[bot + 2]);
      if (t === b) {
        paint(undefined, b);
        out += ' ';
      } else {
        paint(t, b);
        out += '▀';
      }
    }
  }
  return out + '\u001b[0m';
}

export interface IntroOptions {
  /** Frame interval in milliseconds. */
  frameMs?: number;
  /** Resolves when the agent is ready; the tunnel keeps rushing until then. */
  until?: Promise<unknown>;
  /** Clock in milliseconds; tests pass a fake one. */
  now?: () => number;
}

const ENTER_SCREEN = '\u001b[?1049h\u001b[?25l\u001b[2J';
const LEAVE_SCREEN = '\u001b[0m\u001b[?25h\u001b[?1049l';

/** Where the frames go and what the loop needs to know; shared by the thread and the worker. */
export interface IntroSink {
  write(s: string): void | Promise<void>;
  size(): [cols: number, rows: number];
  ready(): boolean;
}

/** The frame loop: plays the story into `sink` until the agent is ready and the exit is done. */
export async function runIntro(sink: IntroSink, opts: Pick<IntroOptions, 'frameMs' | 'now'> = {}): Promise<void> {
  const frameMs = opts.frameMs ?? 40;
  const clock = opts.now ?? (() => performance.now());
  await sink.write(ENTER_SCREEN);
  try {
    const started = clock();
    let last = started;
    let t = 0;
    let exitAt: number | undefined;
    for (;;) {
      const now = clock();
      // Time-based, so a late frame drops a frame rather than slowing the story; the clamp only
      // keeps a long stall from skipping a whole scene.
      const dt = Math.min(0.4, (now - last) / 1000);
      last = now;
      const ready = sink.ready();
      // The animation hides the startup wait and must not add one: once the agent is ready,
      // hurry to the tunnel.
      t += dt * (ready && t < TUNNEL_START ? CATCH_UP : 1);
      if (ready && exitAt === undefined && t >= TUNNEL_START + TUNNEL_MIN) exitAt = t;
      const exit = exitAt === undefined ? undefined : clamp((t - exitAt) / EXIT);
      // The size is read every frame: the scene follows the terminal if it is resized mid-flight.
      const [cols, rows] = sink.size();
      await sink.write(introFrame(t, cols, rows, exit).ansi);
      if (exit === 1) break;
      // Never hold the terminal hostage if startup hangs.
      if (now - started > 60_000) break;
      // Keep a steady pace: sleep only what is left of this frame's slot.
      await new Promise((r) => setTimeout(r, Math.max(0, frameMs - (clock() - now))));
    }
  } finally {
    await sink.write(LEAVE_SCREEN);
  }
}

/**
 * Play the story on the alternate screen in this thread, then restore the terminal.
 * Returns once the animation is done and `until` has settled.
 */
export async function playIntro(out: NodeJS.WriteStream, opts: IntroOptions = {}): Promise<void> {
  let ready = opts.until === undefined;
  void opts.until?.then(
    () => (ready = true),
    () => (ready = true),
  );
  await runIntro(
    {
      // A slow terminal pushes back; wait for it rather than queueing frames it will show late.
      write: (s) => {
        if (!out.write(s) && typeof out.once === 'function') return new Promise<void>((r) => out.once('drain', () => r()));
      },
      size: () => [out.columns ?? 80, out.rows ?? 24],
      ready: () => ready,
    },
    opts,
  );
}

/**
 * Play the story from a worker thread that writes straight to the terminal's file descriptor.
 * The main thread is busy importing the app and starting the agent, and every stall there would
 * freeze the picture; the worker keeps the frames coming regardless.
 * Returns undefined when there is no built worker to run (e.g. running from source).
 */
function playInWorker(out: NodeJS.WriteStream, theme: ThemeName | undefined, until: Promise<unknown>): Promise<void> | undefined {
  const file = new URL('./intro-worker.js', import.meta.url);
  const fd = (out as NodeJS.WriteStream & { fd?: number }).fd;
  if (fd === undefined || !fs.existsSync(fileURLToPath(file))) return undefined;
  let worker: Worker;
  try {
    worker = new Worker(file, { workerData: { fd, cols: out.columns ?? 80, rows: out.rows ?? 24, theme } satisfies IntroWorkerData });
  } catch {
    return undefined;
  }
  let finished = false;
  // If the process dies mid-flight, do not leave the terminal on the alternate screen.
  const restore = () => {
    if (finished) return;
    finished = true;
    try {
      fs.writeSync(fd, LEAVE_SCREEN);
    } catch {
      /* the terminal is gone */
    }
  };
  process.once('exit', restore);
  // Ctrl+C before the interface is up would otherwise kill us without an 'exit' event.
  const interrupt = () => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', interrupt);
  const onResize = () => worker.postMessage({ type: 'size', cols: out.columns ?? 80, rows: out.rows ?? 24 });
  out.on('resize', onResize);
  const signal = () => worker.postMessage({ type: 'ready' });
  void until.then(signal, signal);
  return new Promise<void>((resolve) => {
    const end = (crashed: boolean) => {
      out.off('resize', onResize);
      process.off('exit', restore);
      process.off('SIGINT', interrupt);
      if (crashed) restore();
      finished = true;
      void worker.terminate();
      resolve();
    };
    worker.on('message', (m: { type: string }) => m.type === 'done' && end(false));
    worker.on('error', () => end(true));
    worker.on('exit', () => end(!finished));
  });
}

export interface IntroWorkerData {
  fd: number;
  cols: number;
  rows: number;
  theme?: ThemeName;
}

export interface IntroHandle {
  /** Hand over the startup promise; the animation finishes as soon as it settles. */
  release(until: Promise<unknown>): void;
  /** Resolves once the terminal is restored. */
  done: Promise<void>;
}

/**
 * Start the animation right away, before the agent (or even the rest of the app) is loaded,
 * so the first frame is on screen while the heavy imports are still being evaluated.
 * Returns undefined when the intro is off (no TTY, ALTERAN_NO_INTRO=1, `"intro": false`).
 */
export function startIntro(cwd: string, out: NodeJS.WriteStream = process.stdout): IntroHandle | undefined {
  if (!out.isTTY || process.env.ALTERAN_NO_INTRO === '1') return undefined;
  const { settings } = loadSettings(cwd);
  // The animation is decoration, so reduced motion drops it entirely.
  if (!wantsIntro(settings)) return undefined;
  const theme = (process.env.ALTERAN_THEME as ThemeName | undefined) ?? (settings.theme as ThemeName | undefined);
  applyTheme(theme);
  let release!: (until: Promise<unknown>) => void;
  // Resolving with the handed-over promise adopts it, so this settles when startup does.
  const until = new Promise<unknown>((r) => (release = r));
  const done = playInWorker(out, theme, until) ?? playIntro(out, { until });
  return { release, done };
}
