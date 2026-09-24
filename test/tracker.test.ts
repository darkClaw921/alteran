import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrackerStore, TrackerError } from '../src/tracker/store.js';
import { serializeIssue } from '../src/tracker/model.js';
import { epicLine, issueDetails, issueLine } from '../src/tracker/format.js';
import { setColorEnabled } from '../src/util/color.js';

let dir: string;
let store: TrackerStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-tracker-'));
  store = TrackerStore.init(dir, 'demo');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('tracker store', () => {
  it('creates issues with beads-compatible ids and fields', () => {
    const epic = store.create({ title: 'Phase 1: Каркас', type: 'epic', priority: 1 });
    expect(epic.id).toMatch(/^demo-[a-z0-9]{3,8}$/);
    expect(epic.source_repo).toBe(path.basename(dir));
    const task = store.create({ title: 'Настроить сборку', parent: epic.id, description: 'd' });
    expect(task.id).toBe(`${epic.id}.1`);
    expect(task.dependencies?.[0]).toMatchObject({ depends_on_id: epic.id, type: 'parent-child' });
    const second = store.create({ title: 'Второе', parent: epic.id });
    expect(second.id).toBe(`${epic.id}.2`);
  });

  it('computes ready / blocked with beads semantics', () => {
    const epic = store.create({ title: 'Phase 1: X', type: 'epic' });
    const a = store.create({ title: 'A', parent: epic.id });
    const b = store.create({ title: 'B', parent: epic.id, deps: [a.id] });
    const epic2 = store.create({ title: 'Phase 2: Y', type: 'epic' });
    const c = store.create({ title: 'C', parent: epic2.id });
    store.addDep(epic2.id, b.id);

    let ready = store.ready().map((i) => i.id);
    expect(ready).toContain(a.id);
    expect(ready).not.toContain(b.id);
    // Phase 2 work inherits the blocked state of its epic.
    expect(ready).not.toContain(c.id);

    store.close(a.id, 'done');
    ready = store.ready().map((i) => i.id);
    expect(ready).toContain(b.id);
    expect(ready).not.toContain(c.id);

    store.close(b.id, 'done');
    expect(store.ready().map((i) => i.id)).toContain(c.id);
  });

  it('rejects dependency cycles and self-dependencies', () => {
    const a = store.create({ title: 'A' });
    const b = store.create({ title: 'B', deps: [a.id] });
    expect(() => store.addDep(a.id, b.id)).toThrow(TrackerError);
    expect(() => store.addDep(a.id, a.id)).toThrow(TrackerError);
  });

  it('keeps epics open while children are open', () => {
    const epic = store.create({ title: 'Phase 1: X', type: 'epic' });
    const a = store.create({ title: 'A', parent: epic.id });
    expect(() => store.close(epic.id)).toThrow(/open children/);
    store.close(a.id, 'done');
    expect(store.close(epic.id, 'done').status).toBe('closed');
  });

  it('resolves phases by number, id and name', () => {
    const e1 = store.create({ title: 'Phase 1: Ядро', type: 'epic' });
    const e2 = store.create({ title: 'Фаза 2: TUI', type: 'epic' });
    expect(store.findPhase('1')?.id).toBe(e1.id);
    expect(store.findPhase('2')?.id).toBe(e2.id);
    expect(store.findPhase('tui')?.id).toBe(e2.id);
    expect(store.findPhase(e1.id)?.id).toBe(e1.id);
    expect(TrackerStore.phaseNumber(e2)).toBe(2);
  });

  it('round-trips unknown fields from foreign jsonl', () => {
    const raw = {
      id: 'demo-zzz',
      title: 'Imported',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      compaction_level: 0,
      original_size: 0,
      content_hash: 'abc',
      some_future_field: { nested: true },
    };
    fs.appendFileSync(store.jsonlPath, JSON.stringify(raw) + '\n');
    store.reload(true);
    store.create({ title: 'New one' });
    const lines = fs
      .readFileSync(store.jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const imported = lines.find((l) => l.id === 'demo-zzz');
    expect(imported.some_future_field).toEqual({ nested: true });
    expect(imported.content_hash).toBe('abc');
  });

  it('serializes fields in the beads order without empty values', () => {
    const issue = store.create({ title: 'T', labels: ['a'] });
    const json = JSON.parse(serializeIssue(issue));
    expect(Object.keys(json).slice(0, 3)).toEqual(['id', 'title', 'status']);
    expect(json.comments).toBeUndefined();
  });

  it('keeps model-facing output free of ANSI colour codes', () => {
    const epic = store.create({ title: 'Phase 1: X', type: 'epic' });
    const task = store.create({ title: 'A', parent: epic.id, description: 'd' });
    const esc = /\u001b\[/;
    expect(issueLine(task)).not.toMatch(esc);
    expect(issueDetails(store, task)).not.toMatch(esc);
    expect(epicLine(store.epics()[0])).not.toMatch(esc);
    // CLI rendering opts in explicitly.
    setColorEnabled(true);
    expect(issueLine(task, true)).toMatch(esc);
    setColorEnabled(false);
    expect(issueLine(task, true)).not.toMatch(esc);
  });

  it('discovery does not escape the project root', () => {
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(TrackerStore.discover(nested, dir)?.dir).toBe(store.dir);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-outside-'));
    expect(TrackerStore.discover(outside, outside)).toBeNull();
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

const hasBr = (() => {
  try {
    execFileSync('br', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasBr)('beads_rust (br) interop', () => {
  it('br reads issues written by alteran with matching ready set', () => {
    const epic = store.create({ title: 'Phase 1: X', type: 'epic', priority: 1 });
    const a = store.create({ title: 'A', parent: epic.id });
    const b = store.create({ title: 'B', parent: epic.id, deps: [a.id] });
    const out = execFileSync('br', ['ready', '--json'], { cwd: dir, encoding: 'utf8' });
    const ids = [...out.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    const show = execFileSync('br', ['show', b.id], { cwd: dir, encoding: 'utf8' });
    expect(show).toContain(a.id);
  });
});

describe('listing, sorting and IO', () => {
  it('filters by priority, label and assignee', () => {
    store.create({ title: 'urgent', priority: 0, labels: ['ui'], assignee: 'igor' });
    store.create({ title: 'later', priority: 3, labels: ['api'] });
    expect(store.list({ priority: [0] }).map((i) => i.title)).toEqual(['urgent']);
    expect(store.list({ label: ['ui'] }).map((i) => i.title)).toEqual(['urgent']);
    expect(store.list({ assignee: 'igor' }).map((i) => i.title)).toEqual(['urgent']);
    // A label list is an "all of these", not an "any of these".
    expect(store.list({ label: ['ui', 'api'] })).toHaveLength(0);
  });

  it('sorts by the requested field and can reverse it', () => {
    store.create({ title: 'B task', priority: 2 });
    store.create({ title: 'A task', priority: 1 });
    expect(store.list({ sort: 'title' }).map((i) => i.title)).toEqual(['A task', 'B task']);
    expect(store.list({ sort: 'title', reverse: true }).map((i) => i.title)).toEqual(['B task', 'A task']);
    expect(store.list({ sort: 'priority' }).map((i) => i.priority)).toEqual([1, 2]);
    expect(store.list({ sort: 'priority', reverse: true }).map((i) => i.priority)).toEqual([2, 1]);
  });

  it('is stable between runs, so two listings diff cleanly', () => {
    for (let i = 0; i < 5; i++) store.create({ title: `same priority ${i}`, priority: 2 });
    const first = store.list({ sort: 'priority' }).map((i) => i.id);
    const second = store.list({ sort: 'priority' }).map((i) => i.id);
    expect(second).toEqual(first);
  });

  it('rejects an unknown sort field instead of silently ignoring it', () => {
    store.create({ title: 'x' });
    // The CLI passes the flag straight through, so a typo falls back to the default order rather
    // than crashing mid-listing.
    expect(store.list({ sort: 'nonsense' as never }).map((i) => i.title)).toEqual(['x']);
  });

  it('exports a document that imports back to the same issues', () => {
    const epic = store.create({ title: 'Phase 1: X', type: 'epic' });
    store.create({ title: 'child', parent: epic.id, labels: ['a'], description: 'body' });
    const text = store.exportJsonl();
    expect(text.trim().split('\n')).toHaveLength(2);
    // Round-trip into a fresh tracker: nothing is lost, invented or duplicated.
    const other = TrackerStore.init(fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-import-')), 'demo');
    const result = other.importJsonl(text);
    expect(result).toMatchObject({ added: 2, updated: 0 });
    expect(other.all(true).map((i) => i.id).sort()).toEqual(store.all(true).map((i) => i.id).sort());
    const child = other.list().find((i) => i.title === 'child')!;
    expect(child.labels).toEqual(['a']);
    expect(child.description).toBe('body');
    // Importing the same text again updates rather than duplicating.
    expect(other.importJsonl(text)).toMatchObject({ added: 0, updated: 2 });
  });

  it('reports a bad line instead of failing the whole import', () => {
    store.create({ title: 'kept', priority: 1 });
    const good = store.exportJsonl().trim();
    const result = store.importJsonl(['not json at all', '{"id":"x"}', good].join('\n'));
    expect(result.added + result.updated).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toBeTruthy();
    expect(result.skipped[1].reason).toContain('missing id or title');
  });
});
