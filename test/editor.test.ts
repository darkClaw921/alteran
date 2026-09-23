import { describe, expect, it } from 'vitest';
import { PasteBuffer, editKey, lineEnd, lineStart, pasteInto, type Draft } from '../src/tui/editor.js';
import { notification } from '../src/tui/notify.js';

const draft = (text: string, cursor = text.length, mode: 'insert' | 'normal' = 'insert'): Draft => ({ text, cursor, mode });
const at = (d: Draft, ch: string) => editKey(d, { ch }, 'vi').draft;

describe('emacs editing', () => {
  it('inserts at the cursor, not at the end', () => {
    expect(editKey(draft('ac', 1), { ch: 'b' }, 'emacs').draft).toEqual({ text: 'abc', cursor: 2, mode: 'insert' });
  });

  it('moves with the arrows and deletes on both sides', () => {
    expect(editKey(draft('abc', 1), { leftArrow: true }, 'emacs').draft.cursor).toBe(0);
    expect(editKey(draft('abc', 1), { rightArrow: true }, 'emacs').draft.cursor).toBe(2);
    expect(editKey(draft('abc', 1), { backspace: true }, 'emacs').draft).toEqual({ text: 'bc', cursor: 0, mode: 'insert' });
    expect(editKey(draft('abc', 1), { delete: true }, 'emacs').draft).toEqual({ text: 'ac', cursor: 1, mode: 'insert' });
  });

  it('stops at the ends instead of wrapping', () => {
    expect(editKey(draft('abc', 0), { leftArrow: true }, 'emacs').draft.cursor).toBe(0);
    expect(editKey(draft('abc', 3), { rightArrow: true }, 'emacs').draft.cursor).toBe(3);
    expect(editKey(draft('abc', 3), { delete: true }, 'emacs').draft.text).toBe('abc');
  });

  it('leaves ctrl chords alone so the rest of the line can use them', () => {
    expect(editKey(draft('abc'), { ch: 'k', ctrl: true }, 'emacs').draft.text).toBe('abc');
  });
});

describe('vi editing', () => {
  it('leaves insert mode with escape and steps back one cell', () => {
    const d = editKey(draft('hello', 5), { escape: true }, 'vi').draft;
    expect(d.mode).toBe('normal');
    expect(d.cursor).toBe(4);
  });

  it('moves by cell, line and word in normal mode', () => {
    const text = 'one two three';
    expect(at(draft(text, 4, 'normal'), 'h').cursor).toBe(3);
    expect(at(draft(text, 4, 'normal'), 'l').cursor).toBe(5);
    expect(at(draft(text, 4, 'normal'), '0').cursor).toBe(0);
    expect(at(draft(text, 4, 'normal'), '$').cursor).toBe(text.length);
    expect(at(draft(text, 0, 'normal'), 'w').cursor).toBe(4);
    expect(at(draft(text, 8, 'normal'), 'b').cursor).toBe(4);
  });

  it('walks by word across a line break', () => {
    const two = 'first line\nsecond here';
    expect(at(draft(two, 0, 'normal'), 'w').cursor).toBe(6);
    expect(lineStart(two, 13)).toBe(11);
    expect(lineEnd(two, 3)).toBe(10);
  });

  it('deletes the character under the cursor and does not go past the end', () => {
    expect(at(draft('abc', 1, 'normal'), 'x').text).toBe('ac');
    expect(at(draft('abc', 3, 'normal'), 'x').text).toBe('abc');
  });

  it('enters insert in the four ways that matter', () => {
    expect(at(draft('abc', 1, 'normal'), 'i')).toEqual({ text: 'abc', cursor: 1, mode: 'insert' });
    expect(at(draft('abc', 1, 'normal'), 'a')).toEqual({ text: 'abc', cursor: 2, mode: 'insert' });
    expect(at(draft('one\ntwo', 5, 'normal'), 'I')).toEqual({ text: 'one\ntwo', cursor: 4, mode: 'insert' });
    expect(at(draft('one\ntwo', 4, 'normal'), 'A')).toEqual({ text: 'one\ntwo', cursor: 7, mode: 'insert' });
  });

  it('opens a line below and does nothing for unknown keys', () => {
    expect(at(draft('abc', 3, 'normal'), 'o')).toEqual({ text: 'abc\n', cursor: 4, mode: 'insert' });
    expect(at(draft('abc', 1, 'normal'), 'Z')).toEqual(draft('abc', 1, 'normal'));
    // Enter in normal mode is a movement, so it must not submit the line.
    expect(editKey(draft('abc', 1, 'normal'), { return: true }, 'vi').submit).toBeUndefined();
  });
});

describe('notifications', () => {
  const event = { kind: 'turn' as const, elapsedMs: 60_000, title: 'alteran', body: 'fix the parser' };

  it('stays silent unless it was asked for', () => {
    expect(notification(undefined, event)).toBeUndefined();
    expect(notification({ mode: 'off' }, event)).toBeUndefined();
  });

  it('rings the bell or asks for a desktop notification', () => {
    expect(notification({ mode: 'bell' }, event)).toBe('\u0007');
    expect(notification({ mode: 'osc9' }, event)).toBe('\u001b]9;alteran: fix the parser\u0007');
    expect(notification({ mode: 'osc9' }, { ...event, body: '' })).toBe('\u001b]9;alteran\u0007');
  });

  it('does not announce work that finished before the user could look away', () => {
    expect(notification({ mode: 'bell', minMs: 15_000 }, { ...event, elapsedMs: 3_000 })).toBeUndefined();
    expect(notification({ mode: 'bell', minMs: 15_000 }, { ...event, elapsedMs: 20_000 })).toBe('\u0007');
    // A body containing the sequence terminator would end the notification early; strip it.
    expect(notification({ mode: 'osc9' }, { ...event, body: 'a\u0007b' })).toBe('\u001b]9;alteran: ab\u0007');
  });
});

describe('paste', () => {
  it('keeps newlines in the line instead of submitting them', () => {
    const d = pasteInto(draft('before ', 7), 'one\ntwo\nthree');
    expect(d.text).toBe('before one\ntwo\nthree');
    expect(d.mode).toBe('insert');
  });

  it('collects a paste that arrives split across reads', () => {
    const buf = new PasteBuffer();
    expect(buf.feed('\u001b[200~hello')).toBeNull();
    expect(buf.active).toBe(true);
    expect(buf.feed(' world')).toBeNull();
    expect(buf.feed('\u001b[201~')).toBe('hello world');
    expect(buf.active).toBe(false);
  });

  it('ignores a chunk that is not a paste at all', () => {
    const buf = new PasteBuffer();
    expect(buf.feed('ordinary keys')).toBeNull();
    expect(buf.active).toBe(false);
  });

  it('takes a paste that arrives whole in one read', () => {
    const buf = new PasteBuffer();
    expect(buf.feed('\u001b[200~multi\nline\u001b[201~')).toBe('multi\nline');
    expect(buf.active).toBe(false);
  });
});
