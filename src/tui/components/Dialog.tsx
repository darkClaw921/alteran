import React from 'react';
import { Box } from 'ink';
import { seg, truncate, wrapLine, type Line } from '../lines.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

export interface DialogOption {
  value: string;
  label: string;
  hint?: string;
}

export interface DialogState {
  title: string;
  body: Line[];
  options: DialogOption[];
  selected: number;
  /** Free-text entry (feedback, "Other"). */
  text?: { prompt: string; value: string };
  multi?: boolean;
  chosen?: Set<number>;
  resolve: (value: string, text?: string) => void;
}

export function DialogView({ state, width }: { state: DialogState; width: number }) {
  const inner = width - 4;
  const border = (title: string): Line => {
    const left = `+-- ${title} `;
    return [seg(left + '-'.repeat(Math.max(0, width - left.length - 1)) + '+', C.gold)];
  };
  const row = (line: Line): Line => {
    const w = line.reduce((s, x) => s + x.text.length, 0);
    return [seg('| ', C.gold), ...line, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.gold)];
  };
  const lines: Line[] = [border(state.title)];
  for (const b of state.body) for (const l of wrapLine(b, inner)) lines.push(row(l));
  if (state.body.length) lines.push(row([]));
  if (state.text) {
    lines.push(row([seg(state.text.prompt, C.muted)]));
    for (const l of wrapLine([seg('> ', C.cyan), seg(state.text.value, C.text), seg('_', C.gold, { bold: true })], inner, 2)) lines.push(row(l));
  } else {
    state.options.forEach((o, i) => {
      const active = i === state.selected;
      const mark = state.multi ? (state.chosen?.has(i) ? '[x] ' : '[ ] ') : '';
      lines.push(
        row([
          seg(active ? ' > ' : '   ', active ? C.gold : C.dim),
          seg(`${i + 1}. `, C.muted),
          seg(mark, active ? C.gold : C.muted),
          seg(truncate(o.label, inner - 12), active ? C.text : C.muted, { bold: active }),
          seg(o.hint ? `  ${truncate(o.hint, Math.max(0, inner - o.label.length - 18))}` : '', C.dim),
        ]),
      );
    });
  }
  lines.push([seg('+' + '-'.repeat(Math.max(0, width - 2)) + '+', C.gold)]);
  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}
