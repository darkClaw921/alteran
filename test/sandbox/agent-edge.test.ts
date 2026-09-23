/**
 * Edge cases of an agent actually operating: real shell commands, deferred work that fires on a
 * timer, agents launching agents, and the permission refusals that are supposed to stop all of it.
 *
 * These run in a throwaway container (`pnpm test:sandbox`), never on a developer machine: several
 * of them exist precisely to prove that a scheduled `rm` or an unapproved command does *not* run,
 * and a regression in that code should destroy a container, not someone's working tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeRuntime as scriptedRuntime, textTurn, toolTurn, until, useTempDirs } from '../scripted.js';
import type { Provider, StreamEvent } from '../../src/types.js';

const dirs = useTempDirs('sandbox');
const makeRuntime = (turns: StreamEvent[][], mode: 'autonomous' | 'default' | 'plan' = 'autonomous') => scriptedRuntime(dirs, turns, mode);
const signal = () => new AbortController().signal;
const spawnReq = (prompt = 'work') => ({ agentType: 'general-purpose', description: 'a task', prompt, signal: signal() });

beforeAll(() => {
  if (!fs.existsSync('/.dockerenv') && process.env.ALTERAN_SANDBOX !== '1') {
    throw new Error('This suite runs real commands and must run in the sandbox container: pnpm test:sandbox');
  }
});

describe('delegation edges', () => {
  it('reports an unknown agent type instead of throwing', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('t1', 'Task', { description: 'x', prompt: 'x', subagent_type: 'no-such-agent' }), textTurn('told the user'));
    const out = await rt.main.send('delegate', signal());
    expect(out).toBe('told the user');
    const result = JSON.stringify(provider.requests.at(-1)!.messages.at(-1));
    expect(result).toContain('Unknown agent type');
    expect(result).toContain('general-purpose');
  });

  it('refuses to delegate past the nesting budget', async () => {
    const { rt, provider } = await makeRuntime([]);
    rt.settings.agents = { maxDepth: 1 };
    provider.turns.push(toolTurn('t1', 'Task', { description: 'x', prompt: 'x' }), textTurn('did it myself'));
    await rt.main.send('delegate', signal());
    // The orchestrator is at depth 0, so one level is still allowed; its child is not.
    rt.settings.agents = { maxDepth: 0 };
    expect(() => rt.agents.spawn({ ...spawnReq(), parent: rt.main })).toThrow(/Nesting limit/);
  });

  it('stops background children when the orchestrator is interrupted', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('x1', 'Read', { file_path: 'nope.txt' }), textTurn('unreached'));
    const ac = new AbortController();
    const run = rt.agents.spawn({ ...spawnReq(), parent: rt.main, signal: ac.signal, background: true });
    ac.abort();
    expect((await run.turn).state).toBe('stopped');
  });

  it('turns a provider failure inside an agent into a report, not a crash', async () => {
    const { rt } = await makeRuntime([]);
    const exploding: Provider = {
      id: 'boom',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('upstream exploded');
      },
    };
    rt.registry.get = () => exploding;
    const result = await rt.agents.spawn({ ...spawnReq(), parent: rt.main, background: true }).turn;
    expect(result.state).toBe('failed');
    expect(result.report).toContain('upstream exploded');
  });

  it('lets a stopped agent be redirected, with its context intact', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('x1', 'Read', { file_path: 'nope.txt' }), textTurn('changed course'));
    const ac = new AbortController();
    const run = rt.agents.spawn({ ...spawnReq('chase the first idea'), parent: rt.main, signal: ac.signal, background: true });
    ac.abort();
    expect((await run.turn).state).toBe('stopped');
    const res = await rt.agents.deliver(run.name, 'forget that, do this instead', signal());
    expect(res).not.toBe('queued');
    expect((res as { state: string }).state).toBe('done');
    // The redirect continues the same conversation rather than starting a fresh agent.
    const resumed = JSON.stringify(provider.requests.at(-1)!.messages);
    expect(resumed).toContain('chase the first idea');
    expect(resumed).toContain('forget that');
  });

  it('hands a background report over exactly once', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(textTurn('found three things'), textTurn('relayed'), textTurn('nothing new'));
    const run = rt.agents.spawn({ ...spawnReq(), parent: rt.main, background: true });
    await run.turn;
    // It finished while the orchestrator was idle, so the report waits for its next turn.
    expect(run.pending).toBe(false);
    expect(rt.main.pendingContext.join('\n')).toContain('found three things');

    await rt.main.send('what did it find?', signal());
    const first = JSON.stringify(provider.requests[1].messages);
    expect(first).toContain('found three things');
    await rt.main.send('anything else?', signal());
    const second = JSON.stringify(provider.requests[2].messages.at(-1));
    expect(second).not.toContain('found three things');
  });

  it('collects several finished agents into one notification', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(textTurn('report one'), textTurn('report two'), textTurn('relayed'));
    const a = rt.agents.spawn({ ...spawnReq(), parent: rt.main, background: true });
    const b = rt.agents.spawn({ ...spawnReq(), parent: rt.main, background: true });
    await Promise.all([a.turn, b.turn]);
    await rt.main.send('and?', signal());
    const sent = JSON.stringify(provider.requests.at(-1)!.messages);
    expect(sent).toContain('report one');
    expect(sent).toContain('report two');
  });

  it('wakes an idle nested parent when its own child reports', async () => {
    const { rt, provider, events } = await makeRuntime([]);
    provider.turns.push(textTurn('parent done'), textTurn('child done'), textTurn('parent again'));
    const parent = rt.agents.spawn({ ...spawnReq(), parent: rt.main, background: true });
    await parent.turn;
    const child = rt.agents.spawn({ ...spawnReq(), parent: parent.agent, background: true });
    await child.turn;

    // The parent had already reported, so it is woken with its context and reports onward itself.
    await until(() => events.some((e) => e.type === 'agent_start' && e.agentId === parent.agent.id && e.resumed));
    await until(() => JSON.stringify(parent.agent.messages).includes('child done'));
    expect(JSON.stringify(parent.agent.messages)).toContain('<task-notification>');
  });

  it('names what it knows when asked about an agent that does not exist', async () => {
    const { rt } = await makeRuntime([]);
    await expect(rt.agents.deliver('ghost-1', 'hello', signal())).rejects.toThrow(/No agent named "ghost-1"/);
    expect(() => rt.agents.stop('ghost-1')).toThrow(/None have been launched yet/);
    rt.agents.spawn({ ...spawnReq(), parent: rt.main, background: true });
    expect(() => rt.agents.stop('ghost-1')).toThrow(/general-purpose-1/);
  });
});

describe('deferred work edges', () => {
  const schedulable = async (mode: 'autonomous' | 'default' = 'autonomous') => {
    const made = await makeRuntime([], mode);
    // The Schedule tool refuses a run that ends as soon as it answers; here there is a session.
    made.rt.ui = {};
    return made;
  };

  it('rejects a spec it cannot act on', async () => {
    const { rt } = await schedulable();
    expect(() => rt.schedule.create({ kind: 'prompt', in: '1m', at: '2030-01-01T00:00', message: 'x' })).toThrow(/either `in` or `at`/);
    expect(() => rt.schedule.create({ kind: 'prompt', at: 'tomorrow-ish', message: 'x' })).toThrow(/Cannot read the time/);
    expect(() => rt.schedule.create({ kind: 'command', in: '1m' })).toThrow(/needs `command`/);
    expect(() => rt.schedule.create({ kind: 'message', in: '1m', message: 'hi', to: 'ghost-1' })).toThrow(/No agent named/);
    expect(rt.schedule.list()).toHaveLength(0);
  });

  it('pushes a time that already passed to the nearest moment it can run', async () => {
    const { rt } = await schedulable();
    const item = rt.schedule.create({ kind: 'prompt', at: '2020-01-01T00:00:00Z', message: 'late' });
    expect(item.state).toBe('waiting');
    expect(item.dueAt).toBeGreaterThan(Date.now());
  });

  it('runs a real command and brings its output back', async () => {
    const { rt } = await schedulable();
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    const stamp = path.join(dirs.dir, 'ran.txt');
    rt.schedule.create({ kind: 'command', in: '1s', command: `echo scheduled-ok > ${JSON.stringify(stamp)} && echo done` });
    const text = await until(() => woken[0]);
    expect(text).toContain('done');
    expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('scheduled-ok');
    expect(rt.schedule.list()[0].state).toBe('done');
  });

  it('reports a failing command as failed, with what it printed', async () => {
    const { rt } = await schedulable();
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    rt.schedule.create({ kind: 'command', in: '1s', command: 'echo bad-news >&2; exit 3' });
    const text = await until(() => woken[0]);
    expect(text).toContain('bad-news');
    expect(text).toContain('has run and failed');
    expect(rt.schedule.list()[0].state).toBe('failed');
  });

  it('never runs a command the rules deny', async () => {
    fs.mkdirSync(path.join(dirs.dir, '.alteran'), { recursive: true });
    fs.writeFileSync(path.join(dirs.dir, '.alteran', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
    const { rt } = await schedulable();
    const victim = path.join(dirs.dir, 'keep-me.txt');
    fs.writeFileSync(victim, 'still here');
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    rt.schedule.create({ kind: 'command', in: '1s', command: `rm -f ${JSON.stringify(victim)}` });
    await until(() => woken[0]);
    // Deferring work is not a way around the rules that govern running it now.
    expect(fs.existsSync(victim)).toBe(true);
    expect(rt.schedule.list()[0].state).toBe('failed');
  });

  it('refuses a command that would need approval when there is nobody to ask', async () => {
    const { rt } = await schedulable('default');
    const stamp = path.join(dirs.dir, 'should-not-exist.txt');
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    rt.schedule.create({ kind: 'command', in: '1s', command: `touch ${JSON.stringify(stamp)}` });
    const text = await until(() => woken[0]);
    expect(text).toContain('Permission required');
    expect(fs.existsSync(stamp)).toBe(false);
  });

  it('stops repeating once it is cancelled mid-run', async () => {
    const { rt } = await schedulable();
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    const item = rt.schedule.create({ kind: 'command', in: '1s', every: '5s', command: 'sleep 1; echo tick' });
    await until(() => item.state === 'running');
    rt.schedule.cancel(item.id);
    await until(() => woken.length > 0 || item.runs > 1, 4000).catch(() => undefined);
    // The run in flight finishes; what must not happen is a second one.
    expect(item.state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 1500));
    expect(item.runs).toBe(1);
  });

  it('drops everything still pending when the session ends', async () => {
    const { rt } = await schedulable();
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    const stamp = path.join(dirs.dir, 'after-exit.txt');
    rt.schedule.create({ kind: 'command', in: '1s', command: `touch ${JSON.stringify(stamp)}` });
    await rt.shutdown();
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(stamp)).toBe(false);
    expect(woken).toEqual([]);
    expect(rt.schedule.list()[0].state).toBe('cancelled');
  });
});
