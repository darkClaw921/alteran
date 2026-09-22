import { structuredPatch } from 'diff';
import type { DiffLine } from './types.js';

export interface DiffStats {
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** Line diff with new-file line numbers, grouped into hunks with 2 lines of context. */
export function lineDiff(before: string, after: string, context = 2): DiffStats {
  const patch = structuredPatch('a', 'b', before, after, '', '', { context });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  patch.hunks.forEach((h, i) => {
    if (i > 0) lines.push({ kind: 'sep', text: '...' });
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue;
      const text = l.slice(1);
      if (l[0] === '+') {
        lines.push({ kind: 'add', lineNo: newNo++, text });
        added++;
      } else if (l[0] === '-') {
        lines.push({ kind: 'del', lineNo: oldNo++, text });
        removed++;
      } else {
        lines.push({ kind: 'ctx', lineNo: newNo++, text });
        oldNo++;
      }
    }
  });
  return { added, removed, lines };
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
