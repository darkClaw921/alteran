import { Box } from 'ink';
import { seg, truncate, wrapLine, type Line } from '../lines.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

export interface Suggestion {
  value: string;
  label: string;
  hint?: string;
}

export function SuggestionList({ items, selected, width }: { items: Suggestion[]; selected: number; width: number }) {
  if (!items.length) return null;
  const lines: Line[] = items.map((s, i) => {
    const active = i === selected;
    return [
      seg(active ? ' > ' : '   ', active ? C.gold : C.dim),
      seg(s.label.padEnd(Math.min(28, Math.max(12, ...items.map((x) => x.label.length)))), active ? C.text : C.muted),
      seg('  ' + truncate(s.hint ?? '', Math.max(0, width - 36)), C.dim),
    ];
  });
  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}

export function InputBox({
  value,
  cursor,
  width,
  placeholder,
  queued,
  mode,
}: {
  value: string;
  cursor: number;
  width: number;
  placeholder?: string;
  queued: number;
  mode: string;
}) {
  const inner = width - 4;
  const border = (l: string, r: string) => [seg(l + '-'.repeat(Math.max(0, width - 2)) + r, C.rule)] as Line;
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const rows: Line[] = [];
  const content = value.length ? before + '\u0000' + after : '';
  const logicalLines = (content || placeholder || '').split('\n');
  for (const [i, raw] of logicalLines.entries()) {
    const parts: Line = [];
    if (i === 0) parts.push(seg('> ', mode === 'plan' ? C.amber : C.cyan));
    else parts.push(seg('  ', C.dim));
    if (!value.length) {
      parts.push(seg(truncate(placeholder ?? '', inner - 2), C.dim));
      parts.push(seg('_', C.gold, { bold: true }));
    } else {
      const idx = raw.indexOf('\u0000');
      if (idx >= 0) {
        parts.push(seg(raw.slice(0, idx), C.text));
        parts.push(seg('_', C.gold, { bold: true }));
        parts.push(seg(raw.slice(idx + 1), C.text));
      } else parts.push(seg(raw, C.text));
    }
    rows.push(...wrapLine(parts, inner, 2));
  }
  const body = rows.slice(-8).map((r) => {
    const w = r.reduce((s, x) => s + x.text.length, 0);
    return [seg('| ', C.rule), ...r, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.rule)] as Line;
  });
  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={[border('+', '+'), ...body, border('+', '+')]} />
      {queued > 0 ? <Lines lines={[[seg(`  ${queued} message(s) queued — will be sent when the current run finishes`, C.amber)]]} /> : null}
    </Box>
  );
}
