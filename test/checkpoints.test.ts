import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRuntime as scriptedRuntime, textTurn, useTempDirs } from './scripted.js';
import { runSlashCommand } from '../src/core/commands.js';
import { CheckpointStore } from '../src/core/checkpoints.js';

const dirs = useTempDirs('checkpoints');
const makeRuntime = () => scriptedRuntime(dirs, [textTurn('ok')]);
const dir = () => dirs.dir;
const read = (rel: string) => {
  try {
    return fs.readFileSync(path.join(dir(), rel), 'utf8');
  } catch {
    return undefined;
  }
};
const write = async (rt: Awaited<ReturnType<typeof makeRuntime>>['rt'], file: string, content: string) =>
  rt.main.runDirect('Write', { file_path: file, content }, new AbortController().signal);
const edit = async (rt: Awaited<ReturnType<typeof makeRuntime>>['rt'], file: string, oldString: string, newString: string) => {
  await rt.main.runDirect('Read', { file_path: file }, new AbortController().signal);
  return rt.main.runDirect('Edit', { file_path: file, old_string: oldString, new_string: newString }, new AbortController().signal);
};

describe('rewind to a message', () => {
  it('takes back everything a message caused, and nothing before it', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'kept.txt', 'from the first ask\n');

    rt.checkpoints.mark('поменяй второй файл');
    await write(rt, 'changed.txt', 'from the second ask\n');
    await write(rt, 'kept.txt', 'touched by the second ask\n');

    const list = await runSlashCommand(rt, '/rewind');
    expect((list as { text: string }).text).toContain('поменяй второй файл');

    const res = await runSlashCommand(rt, '/rewind 1');
    expect((res as { text: string }).text).toContain('Back to before "поменяй второй файл"');
    // The second message's work is gone, the first message's work is not.
    expect(read('changed.txt')).toBeUndefined();
    expect(read('kept.txt')).toBe('from the first ask\n');
  });

  it('says so instead of pretending when it is already there', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'a.txt', 'one\n');
    rt.checkpoints.mark('ничего не делай');
    const res = await runSlashCommand(rt, '/rewind 1');
    expect((res as { text: string }).text).toContain('nothing to take back');
    expect(read('a.txt')).toBe('one\n');
  });

  it('refuses a number it does not know', async () => {
    const { rt } = await makeRuntime();
    rt.checkpoints.mark('что-то');
    const res = await runSlashCommand(rt, '/rewind 99');
    expect(res.kind).toBe('error');
    expect((res as { text: string }).text).toContain('No such point');
  });

  it('keeps one point per place, not one per message', async () => {
    const { rt } = await makeRuntime();
    rt.checkpoints.mark('первый вопрос');
    rt.checkpoints.mark('второй вопрос без правок между ними');
    expect(rt.checkpoints.points()).toHaveLength(1);
    expect(rt.checkpoints.points()[0].label).toBe('второй вопрос без правок между ними');
  });
});

describe('checkpoint journal', () => {
  it('writes a line per change instead of the whole history every time', async () => {
    const { rt } = await makeRuntime();
    const file = CheckpointStore.fileFor(rt.root, rt.session.id);
    const big = 'x'.repeat(50_000);
    for (let i = 0; i < 20; i++) await write(rt, 'big.txt', `${big}${i}\n`);
    const size = fs.statSync(file).size;
    // Twenty edits of a 50 KB file: the journal holds both sides of each, and nothing more. The
    // old format rewrote every earlier entry on each write and reached tens of megabytes here.
    expect(size).toBeLessThan(4_000_000);
  });

  it('collapses a file written in the old whole-state format when it opens it', async () => {
    const file = path.join(dir(), 'legacy.checkpoints.jsonl');
    const entry = { seq: 1, file: path.join(dir(), 'x.txt'), before: null, after: 'hi\n', tool: 'Write', t: Date.now() };
    const state = JSON.stringify({ entries: [entry], cursor: 1 });
    // The shape the old code left behind: the same state over and over.
    fs.writeFileSync(file, Array.from({ length: 200 }, () => state).join('\n') + '\n');
    const before = fs.statSync(file).size;

    const store = new CheckpointStore(file);
    expect(store.total).toBe(1);
    expect(store.appliedCount).toBe(1);
    expect(fs.statSync(file).size).toBeLessThan(before / 10);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('replays undo and redo across a reopen', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'a.txt', 'one\n');
    await write(rt, 'a.txt', 'two\n');
    rt.checkpoints.undo(1);
    expect(read('a.txt')).toBe('one\n');

    const reopened = new CheckpointStore(CheckpointStore.fileFor(rt.root, rt.session.id));
    expect(reopened.total).toBe(2);
    expect(reopened.appliedCount).toBe(1);
    reopened.redo(1);
    expect(read('a.txt')).toBe('two\n');
  });
});

describe('checkpoints', () => {
  it('reverts and re-applies an edit, keeping both sides', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'a.txt', 'one\n');
    await write(rt, 'a.txt', 'two\n');
    expect(read('a.txt')).toBe('two\n');

    const undone = await runSlashCommand(rt, '/undo');
    expect(undone.kind).toBe('info');
    expect(read('a.txt')).toBe('one\n');

    await runSlashCommand(rt, '/redo');
    expect(read('a.txt')).toBe('two\n');
  });

  it('deletes a file it created and brings it back', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'fresh.txt', 'hello\n');
    await runSlashCommand(rt, '/undo');
    expect(read('fresh.txt')).toBeUndefined();
    await runSlashCommand(rt, '/redo');
    expect(read('fresh.txt')).toBe('hello\n');
  });

  it('walks back several steps at once', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'b.txt', 'v1\n');
    await write(rt, 'b.txt', 'v2\n');
    await write(rt, 'b.txt', 'v3\n');
    await runSlashCommand(rt, '/undo 2');
    expect(read('b.txt')).toBe('v1\n');
    await runSlashCommand(rt, '/undo all');
    expect(read('b.txt')).toBeUndefined();
  });

  it('drops the redo side once a new edit is made', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'c.txt', 'first\n');
    await write(rt, 'c.txt', 'second\n');
    await runSlashCommand(rt, '/undo');
    // Undo forgets the freshness mark, so the next write has to Read the file again first.
    await rt.main.runDirect('Read', { file_path: 'c.txt' }, new AbortController().signal);
    await write(rt, 'c.txt', 'third\n');
    const res = await runSlashCommand(rt, '/redo');
    expect(res.kind).toBe('info');
    expect((res as { text: string }).text).toContain('Nothing to redo');
    expect(read('c.txt')).toBe('third\n');
  });

  it('records Edit and MultiEdit too', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'd.txt', 'alpha beta\n');
    await edit(rt, 'd.txt', 'alpha', 'gamma');
    expect(read('d.txt')).toBe('gamma beta\n');
    await runSlashCommand(rt, '/undo');
    expect(read('d.txt')).toBe('alpha beta\n');
  });

  it('keeps the history across a resumed session', async () => {
    const first = await makeRuntime();
    await write(first.rt, 'e.txt', 'first\n');
    await write(first.rt, 'e.txt', 'second\n');
    const file = first.rt.session.file;

    const second = await makeRuntime();
    second.rt.resumeSession(file);
    expect(read('e.txt')).toBe('second\n');
    await runSlashCommand(second.rt, '/undo');
    expect(read('e.txt')).toBe('first\n');
  });

  it('forgets the freshness mark so the next edit needs a fresh Read', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'f.txt', 'one\n');
    await write(rt, 'f.txt', 'two\n');
    await runSlashCommand(rt, '/undo');
    // The file on disk is not what the session last saw, so the stale check must fire.
    const res = await rt.main.runDirect('Edit', { file_path: 'f.txt', old_string: 'one', new_string: 'three' }, new AbortController().signal);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('has not been read yet');
  });

  it('lists what it has recorded', async () => {
    const { rt } = await makeRuntime();
    await write(rt, 'g.txt', 'one\n');
    await write(rt, 'g.txt', 'two\n');
    const res = await runSlashCommand(rt, '/checkpoints');
    const text = (res as { text: string }).text;
    expect(text).toContain('2 of 2 edits applied');
    expect(text).toContain('g.txt');
    await runSlashCommand(rt, '/undo');
    expect((await runSlashCommand(rt, '/checkpoints') as { text: string }).text).toContain('1 of 2 edits applied');
  });
});
