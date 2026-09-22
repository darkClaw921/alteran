import React from 'react';
import { Box } from 'ink';
import type { SessionSummary } from '../../core/session.js';
import { seg, truncate, type Line } from '../lines.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

export interface SessionPickerState {
  sessions: SessionSummary[];
  query: string;
  index: number;
  /** Session the runtime is currently writing to. */
  current: string;
}

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => `${s.title} ${s.id}`.toLowerCase().includes(q));
}

/** "3m ago", "2h ago", "5d ago" — reading a timestamp takes longer than it should. */
export function ago(date: Date, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
}

export function SessionPickerView({ state, width, height }: { state: SessionPickerState; width: number; height: number }) {
  const inner = width - 4;
  const row = (line: Line): Line => {
    const w = line.reduce((s, x) => s + x.text.length, 0);
    return [seg('| ', C.gold), ...line, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.gold)];
  };
  const title = '+-- RESUME SESSION ';
  const lines: Line[] = [[seg(title + '-'.repeat(Math.max(0, width - title.length - 1)) + '+', C.gold)]];

  const list = filterSessions(state.sessions, state.query);
  const count = `${list.length}${list.length !== state.sessions.length ? `/${state.sessions.length}` : ''} sessions`;
  lines.push(
    row([
      seg('search: ', C.muted),
      seg(state.query, C.text),
      seg('_', C.gold, { bold: true }),
      seg(' '.repeat(Math.max(1, inner - 9 - state.query.length - count.length)), C.bg),
      seg(count, C.dim),
    ]),
  );
  lines.push([seg('|', C.gold), seg('-'.repeat(Math.max(0, width - 2)), C.rule), seg('|', C.gold)]);

  const rows = Math.max(3, height - 5);
  const from = list.length <= rows ? 0 : Math.min(Math.max(0, state.index - Math.floor(rows / 2)), list.length - rows);
  list.slice(from, from + rows).forEach((s, i) => {
    const idx = from + i;
    const active = idx === state.index;
    const here = s.id === state.current;
    const right = `${String(s.messages).padStart(4)} msg  ${ago(s.updatedAt).padStart(9)}`;
    const name = truncate(s.title.replace(/\s+/g, ' '), Math.max(10, inner - right.length - 5));
    lines.push(
      row([
        seg(active ? ' > ' : here ? ' * ' : '   ', active ? C.gold : here ? C.green : C.dim),
        seg(name, active ? C.text : here ? C.green : C.muted, { bold: active }),
        seg(' '.repeat(Math.max(1, inner - 3 - name.length - right.length)), C.bg),
        seg(right, active ? C.gold : C.dim),
      ]),
    );
  });
  if (!list.length) lines.push(row([seg(state.sessions.length ? 'No session matches the filter.' : 'No saved sessions in this project yet.', C.dim)]));

  const picked = list[state.index];
  lines.push([seg('|', C.gold), seg('-'.repeat(Math.max(0, width - 2)), C.rule), seg('|', C.gold)]);
  lines.push(
    row(
      picked
        ? [seg(picked.id, C.bronze), seg(`   ${picked.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}`, C.muted), seg(picked.id === state.current ? '   (current)' : '', C.green)]
        : [seg('', C.bg)],
    ),
  );
  lines.push(
    row([
      seg('^v', C.muted),
      seg(' select  ', C.dim),
      seg('enter', C.muted),
      seg(' resume  ', C.dim),
      seg('esc', C.muted),
      seg(' cancel   ', C.dim),
      seg('type to filter', C.dim),
    ]),
  );
  lines.push([seg('+' + '-'.repeat(Math.max(0, width - 2)) + '+', C.gold)]);

  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}
