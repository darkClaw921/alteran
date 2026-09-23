import { Box, Static } from 'ink';
import { fmtClock, fmtTokens, seg, truncate, type Line } from '../lines.js';
import { entryLines } from '../render.js';
import type { UiStore } from '../store.js';
import { C, SPINNER_VERBS } from '../theme.js';
import { Lines } from './Lines.js';

export function consoleLines(store: UiStore, width: number): Line[] {
  const out: Line[] = [];
  for (const e of store.entries) out.push(...entryLines(e, width, store.expanded, store.tick));
  return out;
}

export function StreamView({ store, width, height, scroll }: { store: UiStore; width: number; height: number; scroll: number }) {
  const all = consoleLines(store, width);
  const start = Math.max(0, all.length - height - scroll);
  const view = all.slice(start, start + height);
  while (view.length < height) view.unshift([]);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Lines lines={view} />
    </Box>
  );
}

/**
 * Inline transcript: finished entries are printed once through <Static>, so they become ordinary
 * terminal output — the wheel scrolls them natively and the mouse selects them, exactly as in a
 * normal shell session. Nothing below re-renders them.
 */
export function StaticTranscript({ store, width }: { store: UiStore; width: number }) {
  const settled = store.settle();
  return (
    <Static items={settled.map((e, i) => ({ entry: e, key: `${i}:${e.v}` }))}>
      {(item) => <Lines key={item.key} lines={entryLines(item.entry, width, store.expanded, store.tick)} />}
    </Static>
  );
}

/** The part of the transcript that can still change (streaming text, running tools). */
export function LiveTail({ store, width, maxHeight }: { store: UiStore; width: number; maxHeight: number }) {
  const lines: Line[] = [];
  for (const e of store.live()) lines.push(...entryLines(e, width, store.expanded, store.tick));
  const view = lines.slice(Math.max(0, lines.length - maxHeight));
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Lines lines={view} />
    </Box>
  );
}

export function StatusLine({ store, width }: { store: UiStore; width: number }) {
  if (!store.running && !store.awaiting) return <Box height={1} />;
  const verb = store.awaiting ? 'Iris hold' : SPINNER_VERBS[Math.floor(store.tick / 12) % SPINNER_VERBS.length];
  const dots = '...'.slice(0, store.tick % 6 < 3 ? 3 : 2);
  const secs = Math.round(store.elapsed / 1000);
  const detail = store.status.detail ? ` - ${truncate(store.status.detail, 28)}` : '';
  const line: Line = [
    seg('* ', C.cyan),
    seg(verb, C.text),
    seg(dots, C.muted),
    seg(`  (esc to interrupt - ${secs}s - ^ ${fmtTokens(store.runTokens)} tokens - chevron ${store.stages.locked}/9${detail})`, C.muted),
  ];
  const t: Line = [seg(fmtClock(store.elapsed), C.muted)];
  const used = line.reduce((w, s) => w + s.text.length, 0);
  const pad = Math.max(1, width - used - 8);
  return (
    <Box width={width} height={1}>
      <Lines lines={[[...line, seg(' '.repeat(pad)), ...t]]} />
    </Box>
  );
}
