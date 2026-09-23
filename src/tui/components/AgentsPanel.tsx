import { fmtTokens, seg, truncate, type Line } from '../lines.js';
import type { AgentRow, UiStore } from '../store.js';
import { C, type Color } from '../theme.js';

const MARKS: Record<AgentRow['state'], string> = { running: '>', done: '+', failed: '!', stopped: 'x' };
const COLORS: Record<AgentRow['state'], Color> = { running: C.cyan, done: C.green, failed: C.red, stopped: C.muted };

function elapsed(row: AgentRow): string {
  const secs = Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}`;
}

/**
 * One row per delegated agent, indented by depth so the tree of who launched whom is readable.
 * Running agents show what they are doing right now; finished ones their cost.
 */
/**
 * How many agent rows the panel has room for, 0 when nothing was ever delegated. Exported for the
 * same reason as `scheduleRowCount`: a selection is an index into the drawn rows.
 */
export function agentRowCount(store: UiStore, height: number): number {
  const n = store.agentTree().length;
  return n ? Math.max(2, Math.min(6, n + (height > 44 ? 1 : 0))) : 0;
}

/**
 * The rows the panel actually shows, in display order. Running agents matter most; when the list
 * outgrows the panel the oldest finished ones drop out. Selecting a row means an index into this
 * list, so it must be the same function the renderer uses — otherwise `x` would cancel the wrong one.
 */
export function agentRows(store: UiStore, rows: number): AgentRow[] {
  const all = store.agentTree();
  if (all.length <= rows) return all;
  return [...all.filter((r) => r.state === 'running'), ...all.filter((r) => r.state !== 'running').slice(-rows)].slice(0, rows);
}

export function agentLines(store: UiStore, width: number, rows: number, selected = -1): Line[] {
  const all = store.agentTree();
  if (!all.length) return [[seg('(nothing delegated)', C.dim)]];
  const shown = agentRows(store, rows);
  const out: Line[] = shown.map((r, i) => {
    const color = COLORS[r.state];
    const indent = '  '.repeat(Math.max(0, r.depth - 1));
    const right = r.state === 'running' ? truncate(r.detail || 'thinking', 18) : `${fmtTokens(r.tokens)} ${elapsed(r)}`;
    const mark = i === selected ? '*' : MARKS[r.state];
    const name = `${indent}${mark} ${r.name}${r.background ? ' ~' : ''}`;
    const gap = Math.max(1, width - name.length - right.length);
    // The focused row is bold: the cursor has to be findable without relying on colour alone.
    return [seg(name, i === selected ? C.gold : color, { bold: i === selected }), seg(' '.repeat(gap), C.bg), seg(right, i === selected ? C.gold : r.state === 'running' ? C.muted : C.dim)];
  });
  if (shown.length < all.length) out.push([seg(`... ${all.length - shown.length} more`, C.dim)]);
  return out;
}

/** Note for the panel header: how many agents are working right now. */
export function agentsNote(store: UiStore): string {
  const all = store.agentTree();
  if (!all.length) return '';
  const running = all.filter((r) => r.state === 'running').length;
  return running ? `${running} running` : `${all.length} done`;
}
