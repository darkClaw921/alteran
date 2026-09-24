import { Box } from 'ink';
import { lineWidth, seg, truncate, type Line } from '../lines.js';
import { entryLines } from '../render.js';
import { C } from '../theme.js';
import type { UiStore } from '../store.js';
import { Lines } from './Lines.js';

export interface SearchState {
  query: string;
  /** Position within the match list, so the overlay can say "3/12". */
  index: number;
  /** Entry indices that matched, recomputed as the query changes. */
  matches: number[];
}

/**
 * Search overlay. It replaces the input area like help and the pickers, and shows the current
 * match's own transcript rendering — the same lines the panel layout would scroll to, so what is
 * previewed here is exactly what `enter` jumps to there.
 */
export function SearchPanel({ state, store, width, height, canScroll }: { state: SearchState; store: UiStore; width: number; height: number; canScroll: boolean }) {
  const inner = width - 4;
  const lines: Line[] = [];
  const border = (title: string): Line => {
    const left = `+-- ${title} `;
    return [seg(left + '-'.repeat(Math.max(0, width - left.length - 1)) + '+', C.gold)];
  };
  const row = (line: Line): Line => {
    const w = lineWidth(line);
    return [seg('| ', C.gold), ...line, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.gold)];
  };
  const rule = (): Line => [seg('|', C.gold), seg('-'.repeat(Math.max(0, width - 2)), C.rule), seg('|', C.gold)];

  const total = state.matches.length;
  const count = total ? `${Math.min(state.index + 1, total)}/${total}` : state.query ? 'no matches' : 'type to search';
  lines.push(border('SEARCH'));
  lines.push(
    row([
      seg('find: ', C.muted),
      seg(state.query, C.text),
      seg('_', C.gold, { bold: true }),
      seg(' '.repeat(Math.max(1, inner - 6 - state.query.length - count.length)), C.bg),
      seg(count, total ? C.green : C.muted),
    ]),
  );
  lines.push(rule());

  // Preview: the matched entry as the transcript draws it, clipped to the room we have.
  const previewRows = Math.max(1, height - 6);
  const entry = total ? store.entries[state.matches[state.index]] : undefined;
  const preview: Line[] = entry ? entryLines(entry, inner, store.expanded, store.tick) : [];
  if (!entry) {
    preview.push([seg(state.query ? 'Nothing in this session matches.' : 'Start typing to search the transcript.', C.dim)]);
  }
  for (const l of preview.slice(0, previewRows)) lines.push(row(l.slice(0, 1).length ? l : []));
  while (lines.length < height - 1) lines.push(row([]));

  const hint = canScroll ? 'enter: jump to it   ↓/↑: next/prev   esc: close' : '↓/↑: next/prev   esc: close (jumping needs the panel layout)';
  lines.push(row([seg(truncate(hint, inner), C.muted)]));

  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}
