import { Box } from 'ink';
import { seg, truncate, type Line } from '../lines.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

/**
 * Help overlay. It replaces the input area while open instead of being pushed into the
 * transcript, so toggling it with `?` never scrolls the conversation away.
 */
export function HelpPanel({ text, width, height, scroll }: { text: string; width: number; height: number; scroll: number }) {
  const inner = width - 4;
  const rows = text.split('\n');
  const view = Math.max(3, height - 3);
  const top = Math.max(0, Math.min(scroll, Math.max(0, rows.length - view)));
  const shown = rows.slice(top, top + view);

  const row = (line: Line): Line => {
    const w = line.reduce((s, x) => s + x.text.length, 0);
    return [seg('| ', C.gold), ...line, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.gold)];
  };
  const title = '+-- HELP ';
  const lines: Line[] = [[seg(title + '-'.repeat(Math.max(0, width - title.length - 1)) + '+', C.gold)]];
  for (const r of shown) {
    const t = truncate(r, inner);
    // Section headings ("Commands:", "Keys:") read as headings; command names stay highlighted.
    if (/^\S.*:$/.test(t)) lines.push(row([seg(t, C.bronze, { bold: true })]));
    else if (t.startsWith('  /')) {
      const at = t.indexOf('  ', 3);
      lines.push(row([seg(t.slice(0, at > 0 ? at : t.length), C.cyan), seg(at > 0 ? t.slice(at) : '', C.muted)]));
    } else lines.push(row([seg(t, C.muted)]));
  }
  const more = rows.length > view ? `${top + 1}-${Math.min(rows.length, top + view)} of ${rows.length}` : '';
  lines.push(
    row([
      seg('^v', C.muted),
      seg(' scroll  ', C.dim),
      seg('?', C.muted),
      seg(' or ', C.dim),
      seg('esc', C.muted),
      seg(' close', C.dim),
      seg(more ? `   ${more}` : '', C.dim),
    ]),
  );
  lines.push([seg('+' + '-'.repeat(Math.max(0, width - 2)) + '+', C.gold)]);

  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}
