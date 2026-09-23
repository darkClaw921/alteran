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

/** Files bigger than this are not copied: a checkpoint must not cost more than the edit. */
const MAX_BYTES = 2 * 1024 * 1024;
/** How many operations the session remembers; older ones are dropped from the bottom. */
const MAX_ENTRIES = 200;

interface Persisted {
  entries: Checkpoint[];
  cursor: number;
}

/**
 * Undo/redo for file writes.
 *
 * The stack is the ordinary one: `cursor` counts how many entries are currently applied, `undo`
 * moves it back and restores each file's `before`, `redo` moves it forward and restores `after`. A
 * fresh write truncates whatever sat above the cursor, exactly like an editor dropping its redo
 * history. Deferred and scheduled runs go through the same write tools, so their edits are
 * revertable too — and a file whose content a turn still needs is only ever touched by an explicit
 * `/undo`, never by a background process.
 */
export class CheckpointStore {
  private entries: Checkpoint[] = [];
  private cursor = 0;
  private seq = 0;

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
    this.cursor = 0;
    this.seq = 0;
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
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this.cursor = this.entries.length;
    this.persist();
    return entry;
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
  undo(count = 1): { files: string[]; skipped: string[] } {
    const files: string[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < count && this.cursor > 0; i++) {
      const entry = this.entries[this.cursor - 1];
      if (entry.skipped) {
        skipped.push(entry.file);
      } else {
        restore(entry.file, entry.before);
        files.push(entry.file);
      }
      this.cursor--;
    }
    if (files.length || skipped.length) this.persist();
    return { files, skipped };
  }

  /** Re-apply the first `count` reverted operations, oldest first. */
  redo(count = 1): { files: string[]; skipped: string[] } {
    const files: string[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < count && this.cursor < this.entries.length; i++) {
      const entry = this.entries[this.cursor];
      if (entry.skipped) {
        skipped.push(entry.file);
      } else {
        restore(entry.file, entry.after);
        files.push(entry.file);
      }
      this.cursor++;
    }
    if (files.length || skipped.length) this.persist();
    return { files, skipped };
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const last = raw.split('\n').filter(Boolean).at(-1);
      if (!last) return;
      const saved = JSON.parse(last) as Persisted;
      this.entries = saved.entries ?? [];
      this.cursor = Math.min(saved.cursor ?? this.entries.length, this.entries.length);
      this.seq = this.entries.reduce((n, e) => Math.max(n, e.seq), 0);
    } catch {}
  }

  /** One line per state, so the newest write wins and a half-written file cannot corrupt the rest. */
  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ entries: this.entries, cursor: this.cursor } satisfies Persisted) + '\n');
    } catch {}
  }
}

function restore(file: string, content: string | null) {
  try {
    if (content === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  } catch {}
}

/** Content of a file, or null when it is not there — the shape a checkpoint stores. */
export function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
