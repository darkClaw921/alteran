import { Box } from 'ink';
import { lineWidth, seg, truncate, type Line } from '../lines.js';
import { diffHunks, shortenPaths } from '../render.js';
import type { DiffLine } from '../../tools/types.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

export interface ReviewState {
  /** Absolute path of the file the edit touched. */
  file: string;
  tool: string;
  diff: DiffLine[];
  added: number;
  removed: number;
  /** How many edits the session has applied in total, so "revert" is understood as one step back. */
  depth: number;
}

/**
 * `/review`: the last applied edit as a hunk diff, with the two things a person can do about it.
 * It is an overlay rather than a transcript entry because it is transient — reading it must not
 * scroll the conversation, and dismissing it must leave no trace.
 */
export function ReviewPanel({ state, width, height }: { state: ReviewState; width: number; height: number }) {
  const inner = width - 4;
  const border = (title: string): Line => {
    const left = `+-- ${title} `;
    return [seg(left + '-'.repeat(Math.max(0, width - left.length - 1)) + '+', C.gold)];
  };
  const row = (line: Line): Line => {
    const w = lineWidth(line);
    return [seg('| ', C.gold), ...line, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.gold)];
  };
  const rule = (): Line => [seg('|', C.gold), seg('-'.repeat(Math.max(0, width - 2)), C.rule), seg('|', C.gold)];

  const lines: Line[] = [border('REVIEW')];
  lines.push(
    row([seg(`${state.tool} `, C.gold, { bold: true }), seg(truncate(shortenPaths(state.file), Math.max(8, inner - state.tool.length - 18)), C.text)]),
  );
  lines.push(row([seg(`${state.added} added, ${state.removed} removed  ·  ${state.depth} edit${state.depth === 1 ? '' : 's'} this session`, C.muted)]));
  lines.push(rule());

  const room = Math.max(1, height - 5);
  const body = diffHunks(state.diff, inner, room);
  for (const l of body) lines.push(row(l));
  while (lines.length < height - 1) lines.push(row([]));
  lines.push(row([seg(truncate('r: revert and restore the file   a/esc: keep it', inner), C.muted)]));

  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}
