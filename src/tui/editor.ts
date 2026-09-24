/**
 * The input line's editing model.
 *
 * Kept as a pure reducer so the awkward parts — walking by word, what `x` deletes in normal mode,
 * where the cursor lands leaving insert — are testable without a terminal. `emacs` mode is the
 * behaviour the line always had; `vi` adds a normal mode in front of it.
 */
export type InputMode = 'emacs' | 'vi';

export interface Draft {
  text: string;
  /** Index in code units, matching `String.prototype.slice`, not a column. */
  cursor: number;
  /** vi only: which mode the line is in. Always `insert` for emacs. */
  mode: 'insert' | 'normal';
}

export interface EditKey {
  ch?: string;
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export const emptyDraft = (mode: 'insert' | 'normal' = 'insert'): Draft => ({ text: '', cursor: 0, mode });

const isWord = (c: string | undefined) => Boolean(c && /\S/.test(c));

/** Start of the line the cursor is on. */
export function lineStart(text: string, cursor: number): number {
  const nl = text.lastIndexOf('\n', Math.max(0, cursor - 1));
  return nl === -1 ? 0 : nl + 1;
}

/** End of the line the cursor is on (the newline itself, or the end of the text). */
export function lineEnd(text: string, cursor: number): number {
  const nl = text.indexOf('\n', cursor);
  return nl === -1 ? text.length : nl;
}

function nextWordStart(text: string, cursor: number): number {
  let i = cursor;
  if (i < text.length && isWord(text[i])) while (i < text.length && isWord(text[i])) i++;
  while (i < text.length && !isWord(text[i])) i++;
  return i;
}

function prevWordStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWord(text[i - 1])) i--;
  while (i > 0 && isWord(text[i - 1])) i--;
  return i;
}

const insertAt = (d: Draft, s: string): Draft => ({ ...d, text: d.text.slice(0, d.cursor) + s + d.text.slice(d.cursor), cursor: d.cursor + s.length });

/**
 * One keypress in the input line. Returns the next draft; `submit` says the line should be sent,
 * which only `enter` in insert mode does — `enter` in normal mode is a movement in vi.
 */
export function editKey(d: Draft, key: EditKey, mode: InputMode = 'emacs'): { draft: Draft; submit?: boolean } {
  const vi = mode === 'vi';
  const effMode: 'insert' | 'normal' = vi ? d.mode : 'insert';

  if (effMode === 'normal' && vi) {
    if (key.escape) return { draft: { ...d, mode: 'normal' } };
    if (key.leftArrow) return { draft: { ...d, cursor: Math.max(0, d.cursor - 1) } };
    if (key.rightArrow) return { draft: { ...d, cursor: Math.min(d.text.length, d.cursor + 1) } };
    if (key.backspace) return { draft: { ...d, cursor: Math.max(0, d.cursor - 1) } };
    const ch = key.ch;
    if (!ch || key.ctrl || key.meta) return { draft: d };
    switch (ch) {
      case 'h':
        return { draft: { ...d, cursor: Math.max(0, d.cursor - 1) } };
      case 'l':
        return { draft: { ...d, cursor: Math.min(d.text.length, d.cursor + 1) } };
      case '0':
        return { draft: { ...d, cursor: lineStart(d.text, d.cursor) } };
      case '$':
        return { draft: { ...d, cursor: lineEnd(d.text, d.cursor) } };
      case 'w':
        return { draft: { ...d, cursor: nextWordStart(d.text, d.cursor) } };
      case 'b':
        return { draft: { ...d, cursor: prevWordStart(d.text, d.cursor) } };
      case 'x': {
        if (d.cursor >= d.text.length) return { draft: d };
        return { draft: { ...d, text: d.text.slice(0, d.cursor) + d.text.slice(d.cursor + 1) } };
      }
      case 'i':
        return { draft: { ...d, mode: 'insert' } };
      case 'a':
        return { draft: { ...d, mode: 'insert', cursor: Math.min(d.text.length, d.cursor + 1) } };
      case 'I':
        return { draft: { ...d, mode: 'insert', cursor: lineStart(d.text, d.cursor) } };
      case 'A':
        return { draft: { ...d, mode: 'insert', cursor: lineEnd(d.text, d.cursor) } };
      case 'o':
        return { draft: insertAt({ ...d, mode: 'insert' }, '\n') };
      case ':':
        // A vi line editor has commands here; this line has none, so say nothing rather than guess.
        return { draft: d };
      default:
        return { draft: d };
    }
  }

  // Insert mode — emacs behaviour, plus the escape that leaves vi's insert mode.
  if (key.escape) return { draft: vi ? { ...d, mode: 'normal', cursor: Math.max(0, d.cursor - 1) } : d };
  if (key.leftArrow) return { draft: { ...d, cursor: Math.max(0, d.cursor - 1) } };
  if (key.rightArrow) return { draft: { ...d, cursor: Math.min(d.text.length, d.cursor + 1) } };
  if (key.backspace) {
    if (d.cursor === 0) return { draft: d };
    return { draft: { ...d, text: d.text.slice(0, d.cursor - 1) + d.text.slice(d.cursor), cursor: d.cursor - 1 } };
  }
  if (key.delete) return { draft: { ...d, text: d.text.slice(0, d.cursor) + d.text.slice(d.cursor + 1) } };
  if (key.ctrl || key.meta) return { draft: d };
  if (key.ch) return { draft: insertAt(d, key.ch) };
  return { draft: d };
}

/** Insert a paste verbatim: newlines land in the line instead of submitting it. */
export function pasteInto(d: Draft, text: string): Draft {
  const clean = text.replace(/\r\n?/g, '\n');
  return insertAt({ ...d, mode: 'insert' }, clean);
}

/** The markers terminals wrap a paste in once bracketed-paste mode is on. */
export const PASTE_START = '\u001b[200~';
export const PASTE_END = '\u001b[201~';

/**
 * Collects a bracketed paste, which may arrive split across reads. Without this the paste comes
 * through as keystrokes — every newline in it an Enter, so pasting a paragraph would send its first
 * line and drop the rest.
 */
export class PasteBuffer {
  private buf: string | null = null;

  /** Feed a raw chunk; returns the finished paste, or null while it is still arriving. */
  feed(chunk: string): string | null {
    if (this.buf === null) {
      const at = chunk.indexOf(PASTE_START);
      if (at === -1) return null;
      this.buf = chunk.slice(at + PASTE_START.length);
    } else {
      this.buf += chunk;
    }
    const end = this.buf.indexOf(PASTE_END);
    if (end === -1) return null;
    const text = this.buf.slice(0, end);
    this.buf = null;
    return text;
  }

  get active(): boolean {
    return this.buf !== null;
  }
}

/** Sequences that turn bracketed paste on and off, so a paste is announced rather than typed. */
export const PASTE_ON = '\u001b[?2004h';
export const PASTE_OFF = '\u001b[?2004l';
