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
export function agentLines(store: UiStore, width: number, rows: number): Line[] {
  const all = store.agentTree();
  if (!all.length) return [[seg('(nothing delegated)', C.dim)]];
  // Running agents matter most; when the list outgrows the panel the oldest finished ones drop out.
  const shown = all.length <= rows ? all : [...all.filter((r) => r.state === 'running'), ...all.filter((r) => r.state !== 'running').slice(-rows)].slice(0, rows);
  const out: Line[] = shown.map((r) => {
    const color = COLORS[r.state];
    const indent = '  '.repeat(Math.max(0, r.depth - 1));
    const right = r.state === 'running' ? truncate(r.detail || 'thinking', 18) : `${fmtTokens(r.tokens)} ${elapsed(r)}`;
    const name = `${indent}${MARKS[r.state]} ${r.name}${r.background ? ' ~' : ''}`;
    const gap = Math.max(1, width - name.length - right.length);
    return [seg(name, color), seg(' '.repeat(gap), C.bg), seg(right, r.state === 'running' ? C.muted : C.dim)];
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
