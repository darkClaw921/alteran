import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from './session.js';

/** One recorded write, with enough of the file on both sides to move either way. */
export interface Checkpoint {
  seq: number;
  /** Absolute path of the file the operation touched. */
  file: string;
  /** Content before the operation; null when the file did not exist yet. */
  before: string | null;
  /** Content the operation produced; null when the operation deleted the file. */
  after: string | null;
  tool: string;
  t: number;
  /** Too large to keep a copy of; the entry is shown but cannot be reverted. */
  skipped?: boolean;
}

/** A point in the history worth naming: the moment the user asked for something. */
export interface Mark {
  id: number;
  /** The message itself, trimmed for display. */
  label: string;
  /** How many edits had been applied when it was made — the state to come back to. */
  at: number;
  t: number;
}

/** Files bigger than this are not copied: a checkpoint must not cost more than the edit. */
const MAX_BYTES = 2 * 1024 * 1024;
/** How many operations the session remembers; older ones are dropped from the bottom. */
const MAX_ENTRIES = 200;
/** Journal lines before the file is rewritten from the live state. */
const MAX_LINES = 400;

/**
 * A line of the journal. Every mutation appends one; the file is rewritten from a single
 * `snapshot` once it has grown enough lines to be worth collapsing.
 */
type Line =
  | { k: 'entry'; base: number; e: Checkpoint }
  | { k: 'cursor'; cursor: number }
  | { k: 'mark'; m: Mark }
  | { k: 'snapshot'; entries: Checkpoint[]; cursor: number; marks: Mark[] }
  /** What every line looked like before the journal existed: the whole state, every time. */
  | { entries: Checkpoint[]; cursor: number };

/**
 * Undo/redo for file writes.
 *
 * The stack is the ordinary one: `cursor` counts how many entries are currently applied, `undo`
 * moves it back and restores each file's `before`, `redo` moves it forward and restores `after`. A
 * fresh write truncates whatever sat above the cursor, exactly like an editor dropping its redo
 * history. Deferred and scheduled runs go through the same write tools, so their edits are
 * revertable too — and a file whose content a turn still needs is only ever touched by an explicit
 * `/undo`, never by a background process.
 *
 * On disk it is a journal: one short line per change. It used to be one line per *state*, which
 * meant every edit rewrote the entire history — a single session left a 182 MB file holding 79
 * edits, and opening it cost a third of a gigabyte of memory. Lines are replayed on load and
 * collapsed into a snapshot once there are enough of them.
 */
export class CheckpointStore {
  private entries: Checkpoint[] = [];
  private marks: Mark[] = [];
  private cursor = 0;
  private seq = 0;
  private markSeq = 0;
  private lines = 0;

  constructor(private file: string) {
    this.load();
  }

  /** Where a session's checkpoints live: beside its transcript, one file per session. */
  static fileFor(root: string, sessionId: string) {
    return path.join(SessionStore.dir(root), `${sessionId}.checkpoints.jsonl`);
  }

  /** Point the store at another session's file (the one that was just resumed). */
  retarget(file: string) {
    if (file === this.file) return;
    this.file = file;
    this.entries = [];
    this.marks = [];
    this.cursor = 0;
    this.seq = 0;
    this.markSeq = 0;
    this.lines = 0;
    this.load();
  }

  /** Record a write. Called after the file was written, with both sides in hand. */
  record(op: { file: string; before: string | null; after: string | null; tool: string }): Checkpoint | undefined {
    if (op.before === op.after) return undefined;
    const tooBig = (op.before?.length ?? 0) > MAX_BYTES || (op.after?.length ?? 0) > MAX_BYTES;
    const entry: Checkpoint = {
      seq: ++this.seq,
      file: op.file,
      before: tooBig ? null : op.before,
      after: tooBig ? null : op.after,
      tool: op.tool,
      t: Date.now(),
      skipped: tooBig || undefined,
    };
    // A new write invalidates anything a previous undo left on the redo side.
    this.entries = this.entries.slice(0, this.cursor);
    this.append({ k: 'entry', base: this.cursor, e: entry });
    this.entries.push(entry);
    this.cursor = this.entries.length;
    if (this.entries.length > MAX_ENTRIES) this.compact();
    return entry;
  }

  /**
   * Name the point the conversation is at, so it can be returned to later. Marks with nothing
   * between them are the same point twice, and only the newest is worth keeping.
   */
  mark(label: string): Mark | undefined {
    const text = label.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!text) return undefined;
    const last = this.marks.at(-1);
    if (last && last.at === this.cursor) this.marks.pop();
    const m: Mark = { id: ++this.markSeq, label: text, at: this.cursor, t: Date.now() };
    this.marks.push(m);
    this.append({ k: 'mark', m });
    return m;
  }

  /** The named points, oldest first, with how many edits each one can still take back. */
  points(): Array<Mark & { undoes: number }> {
    return this.marks.map((m) => ({ ...m, undoes: Math.max(0, this.cursor - m.at) }));
  }

  /** Put the tree back to how it stood when that message was sent. */
  rewind(id: number): { files: string[]; skipped: string[]; failed: string[]; mark: Mark } | { error: string } {
    const mark = this.marks.find((m) => m.id === id);
    if (!mark) return { error: `No such point: ${id}. /rewind lists them.` };
    if (mark.at > this.cursor) return { ...this.redo(mark.at - this.cursor), mark };
    return { ...this.undo(this.cursor - mark.at), mark };
  }

  /** Everything remembered, oldest first, with the ones currently reverted flagged. */
  list(): Array<Checkpoint & { applied: boolean }> {
    return this.entries.map((e, i) => ({ ...e, applied: i < this.cursor }));
  }

  get appliedCount() {
    return this.cursor;
  }

  get total() {
    return this.entries.length;
  }

  /** Revert the last `count` applied operations, newest first. Returns the files touched. */
  undo(count = 1): { files: string[]; skipped: string[]; failed: string[] } {
    return this.move(count, -1);
  }

  /** Re-apply the first `count` reverted operations, oldest first. */
  redo(count = 1): { files: string[]; skipped: string[]; failed: string[] } {
    return this.move(count, 1);
  }

  private move(count: number, dir: -1 | 1): { files: string[]; skipped: string[]; failed: string[] } {
    const files: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < count; i++) {
      if (dir < 0 ? this.cursor <= 0 : this.cursor >= this.entries.length) break;
      const entry = this.entries[dir < 0 ? this.cursor - 1 : this.cursor];
      if (entry.skipped) skipped.push(entry.file);
      else if (restore(entry.file, dir < 0 ? entry.before : entry.after)) files.push(entry.file);
      // A file that could not be written stays as it is; saying otherwise would send the user
      // looking for changes that never happened.
      else failed.push(entry.file);
      this.cursor += dir;
    }
    if (files.length || skipped.length || failed.length) this.append({ k: 'cursor', cursor: this.cursor });
    return { files, skipped, failed };
  }

  private load() {
    let legacy = false;
    let lines = 0;
    forEachLine(this.file, (raw) => {
      lines++;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        return;
      }
      if ('entries' in line && !('k' in line)) {
        // Pre-journal format: the whole state on one line, so the last one seen wins.
        legacy = true;
        this.entries = line.entries ?? [];
        this.cursor = clamp(line.cursor ?? this.entries.length, this.entries.length);
        this.marks = [];
        return;
      }
      if (line.k === 'snapshot') {
        this.entries = line.entries ?? [];
        this.marks = line.marks ?? [];
        this.cursor = clamp(line.cursor ?? this.entries.length, this.entries.length);
      } else if (line.k === 'entry') {
        this.entries = this.entries.slice(0, clamp(line.base, this.entries.length));
        this.entries.push(line.e);
        this.cursor = this.entries.length;
      } else if (line.k === 'cursor') {
        this.cursor = clamp(line.cursor, this.entries.length);
      } else if (line.k === 'mark') {
        this.marks.push(line.m);
      }
    });
    this.seq = this.entries.reduce((n, e) => Math.max(n, e.seq), 0);
    this.markSeq = this.marks.reduce((n, m) => Math.max(n, m.id), 0);
    this.lines = lines;
    // An old file is collapsed the moment it is opened: it is the one chance to stop paying for it.
    if (legacy || lines > MAX_LINES) this.compact();
  }

  private append(line: Line) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
      this.lines++;
      if (this.lines > MAX_LINES) this.compact();
    } catch {}
  }

  /** Drop the journal and write what is actually live: one line, current state. */
  private compact() {
    if (this.entries.length > MAX_ENTRIES) {
      const drop = this.entries.length - MAX_ENTRIES;
      this.entries = this.entries.slice(drop);
      this.cursor = Math.max(0, this.cursor - drop);
      this.marks = this.marks.map((m) => ({ ...m, at: Math.max(0, m.at - drop) }));
    }
    const snapshot: Line = { k: 'snapshot', entries: this.entries, cursor: this.cursor, marks: this.marks };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot) + '\n');
      fs.renameSync(tmp, this.file);
      this.lines = 1;
    } catch {}
  }
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(Number.isFinite(n) ? n : max, max));

/** True when the file now holds `content` (or is gone, for a null). */
function restore(file: string, content: string | null): boolean {
  try {
    if (content === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSONL file a chunk at a time. Reading it whole costs the size of the file in memory
 * twice over — once for the string, once for the split — which is what made opening an old
 * checkpoint file so expensive.
 */
function forEachLine(file: string, onLine: (line: string) => void) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let rest = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const text = rest + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      rest = parts.pop() ?? '';
      for (const p of parts) if (p) onLine(p);
    }
    if (rest) onLine(rest);
  } catch {
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

/** Content of a file, or null when it is not there — the shape a checkpoint stores. */
export function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
