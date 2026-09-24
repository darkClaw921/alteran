import stringWidth from 'string-width';
import { C, type Color } from './theme.js';

export interface Seg {
  text: string;
  color?: Color;
  bg?: Color;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type Line = Seg[];

export const seg = (text: string, color?: Color, extra: Partial<Seg> = {}): Seg => ({ text, color, ...extra });

export function lineWidth(line: Line): number {
  return line.reduce((w, s) => w + stringWidth(s.text), 0);
}

export function textWidth(s: string): number {
  return stringWidth(s);
}

/** Cut a string to at most `max` columns. */
export function sliceWidth(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}

export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (stringWidth(s) <= max) return s;
  return sliceWidth(s, Math.max(0, max - 1)) + '…';
}

export function truncateLine(line: Line, max: number): Line {
  const out: Line = [];
  let w = 0;
  for (const s of line) {
    const sw = stringWidth(s.text);
    if (w + sw <= max) {
      out.push(s);
      w += sw;
    } else {
      const rest = max - w;
      if (rest > 0) out.push({ ...s, text: sliceWidth(s.text, rest) });
      break;
    }
  }
  return out;
}

/** Word-wrap styled segments to `width`, continuing wrapped lines with `indent` columns. */
export function wrapLine(line: Line, width: number, indent = 0): Line[] {
  if (width <= 4) return [truncateLine(line, Math.max(1, width))];
  if (lineWidth(line) <= width) return [line];
  const out: Line[] = [];
  let cur: Line = [];
  let w = 0;
  const pad = ' '.repeat(indent);
  const flush = () => {
    out.push(cur);
    cur = indent ? [{ text: pad }] : [];
    w = indent;
  };
  for (const s of line) {
    const tokens = s.text.split(/(\s+)/).filter((t) => t.length);
    for (const tok of tokens) {
      let t = tok;
      let tw = stringWidth(t);
      if (w + tw <= width) {
        cur.push({ ...s, text: t });
        w += tw;
        continue;
      }
      if (/^\s+$/.test(t)) {
        flush();
        continue;
      }
      if (tw <= width - indent && w > indent) {
        flush();
        cur.push({ ...s, text: t });
        w += tw;
        continue;
      }
      while (tw > 0) {
        const room = width - w;
        if (room <= 0) {
          flush();
          continue;
        }
        const piece = sliceWidth(t, room);
        cur.push({ ...s, text: piece });
        w += stringWidth(piece);
        t = t.slice(piece.length);
        tw = stringWidth(t);
        if (tw > 0) flush();
      }
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function padRight(line: Line, width: number): Line {
  const w = lineWidth(line);
  return w >= width ? truncateLine(line, width) : [...line, { text: ' '.repeat(width - w) }];
}

/** Place `right` flush right on the first line (e.g. timestamps). */
export function withRight(line: Line, right: Line, width: number): Line {
  const rw = lineWidth(right);
  const lw = lineWidth(line);
  if (lw + rw + 1 > width) return truncateLine(line, width);
  return [...line, { text: ' '.repeat(width - lw - rw) }, ...right];
}

export function plain(text: string, color: Color = C.text): Line[] {
  return text.split('\n').map((l) => [seg(l, color)]);
}

/** Inline markdown: **bold**, `code`, *em*, [text](url). */
function inline(text: string, base: Color): Line {
  const out: Line = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<![\w*])\*[^*\s][^*]*\*(?!\w))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(seg(text.slice(last, m.index), base));
    const t = m[0];
    if (t.startsWith('**')) out.push(seg(t.slice(2, -2), C.text, { bold: true }));
    else if (t.startsWith('`')) out.push(seg(t.slice(1, -1), C.cyan));
    else if (t.startsWith('[')) {
      const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(seg(mm[1], C.cyan, { underline: true }));
    } else out.push(seg(t.slice(1, -1), base, { italic: true }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(seg(text.slice(last), base));
  return out;
}

/** Lightweight markdown → styled lines for the console. */
export function markdown(text: string, width: number, base: Color = C.text): Line[] {
  const out: Line[] = [];
  let inFence = false;
  let tableRows: string[][] = [];
  const flushTable = () => {
    if (!tableRows.length) return;
    const cols = Math.max(...tableRows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, i) => Math.max(...tableRows.map((r) => textWidth(r[i] ?? ''))));
    tableRows.forEach((r, ri) => {
      const line: Line = [];
      r.forEach((cell, i) => {
        line.push(seg(cell.padEnd(cell.length + (widths[i] - textWidth(cell))), ri === 0 ? C.gold : base, { bold: ri === 0 }));
        if (i < r.length - 1) line.push(seg(' │ ', C.dim));
      });
      out.push(...wrapLine(line, width));
    });
    tableRows = [];
  };
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      flushTable();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(...wrapLine([seg('  '), seg(raw, C.cyan)], width, 2));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue;
      tableRows.push(
        raw
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim()),
      );
      continue;
    }
    flushTable();
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(...wrapLine([seg(h[2], h[1].length <= 2 ? C.gold : C.bronze, { bold: true })], width));
      continue;
    }
    const li = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = li[1].length;
      const bullet = /\d/.test(li[2]) ? li[2] : '-';
      const prefix = ' '.repeat(indent) + bullet + ' ';
      out.push(...wrapLine([seg(prefix, C.bronze), ...inline(li[3], base)], width, prefix.length));
      continue;
    }
    if (/^\s*>/.test(raw)) {
      out.push(...wrapLine([seg('│ ', C.dim), ...inline(raw.replace(/^\s*>\s?/, ''), C.muted)], width, 2));
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(raw)) {
      out.push([seg('─'.repeat(Math.min(width, 40)), C.dim)]);
      continue;
    }
    out.push(...wrapLine(inline(raw, base), width));
  }
  flushTable();
  return out;
}

export function bar(ratio: number, width: number): string {
  const n = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '#'.repeat(n) + '-'.repeat(width - n);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Net wheel movement in an SGR mouse report (ESC [ < button ; col ; row M/m).
 * Button 64 is wheel up, 65 wheel down; anything else (clicks, motion) counts as zero but is
 * still recognised as a mouse report so it never reaches the input line as text.
 */
export function wheelDelta(raw: string): { wheel: number; isMouse: boolean } {
  let wheel = 0;
  let isMouse = false;
  // Ink strips the leading ESC before handing the sequence to useInput, so it is optional here.
  for (const m of raw.matchAll(/(?:\u001b)?\[<(\d+);\d+;\d+[Mm]/g)) {
    isMouse = true;
    const button = Number(m[1]);
    if (button === 64) wheel += 1;
    else if (button === 65) wheel -= 1;
  }
  return { wheel, isMouse };
}
