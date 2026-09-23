import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRuntime as scriptedRuntime, textTurn, toolTurn, until, useTempDirs, type ScriptedProvider } from './scripted.js';
import { Agent } from '../src/core/agent.js';
import { Runtime } from '../src/core/runtime.js';
import { parseDuration } from '../src/core/schedule.js';
import { cacheLine, contextBar, contextBreakdown, formatContext } from '../src/core/context.js';
import { runSlashCommand } from '../src/core/commands.js';
import { mainSystemPrompt } from '../src/core/prompt.js';
import { SessionStore } from '../src/core/session.js';
import type { ProviderRequest, StreamEvent } from '../src/types.js';
import { ok } from '../src/tools/types.js';

const dirs = useTempDirs('agent');
const makeRuntime = (turns: StreamEvent[][], mode: 'autonomous' | 'default' | 'plan' = 'autonomous') => scriptedRuntime(dirs, turns, mode);
const dir = () => dirs.dir;

describe('system prompt', () => {
  it('trims catalog entries and drops blocks the agent cannot use', async () => {
    const { rt } = await makeRuntime([textTurn('ok')]);
    const full = rt.main.system;
    expect(full).toContain('# Agent types for the Task tool');
    expect(full).toContain('# The CONSILIUM task tracker');
    // Human-facing example transcripts never belong in the prompt.
    expect(full).not.toContain('<example>');
    expect(full).not.toMatch(/Examples:\s*$/m);

    const env = rt.envInfo(rt.model);
    const lean = mainSystemPrompt(rt.ext, env, [], { task: false, skill: false, tracker: false });
    expect(lean).not.toContain('# Agent types for the Task tool');
    expect(lean).not.toContain('# Skills');
    expect(lean).not.toContain('# The CONSILIUM task tracker');
    // Dropping a section must not swallow the ones after it.
    expect(lean).toContain('# Planning');
    expect(lean).toContain('# Safety');
    expect(lean.length).toBeLessThan(full.length);

    // The working directory is not repeated when it is the project root.
    expect(rt.envInfo(rt.model).root).toBe(rt.cwd);
    expect(full).not.toContain('Project root:');
  });
});

describe('sessions', () => {
  it('continues a saved session in place instead of forking it', async () => {
    const first = await makeRuntime([textTurn('first answer')]);
    await first.rt.main.send('remember this', new AbortController().signal);
    const id = first.rt.session.id;
    const file = first.rt.session.file;

    const second = await makeRuntime([textTurn('second answer')]);
    expect(second.rt.session.id).not.toBe(id);
    const resumed = second.rt.resumeSession(file);
    expect(resumed.id).toBe(id);
    expect(second.rt.main.messages).toHaveLength(2);
    // Further turns land in the resumed file, not the session this process started with.
    expect(second.rt.session.file).toBe(file);
    await second.rt.main.send('and this', new AbortController().signal);
    const { messages } = SessionStore.load(file);
    expect(messages).toHaveLength(4);
    expect(SessionStore.list(second.rt.root).map((x) => x.id)).toContain(id);
  });

  it('resolves /resume by id prefix', async () => {
    const { rt } = await makeRuntime([textTurn('ok')]);
    await rt.main.send('hello', new AbortController().signal);
    const res = await runSlashCommand(rt, `/resume ${rt.session.id.slice(0, 8)}`);
    expect(res).toEqual({ kind: 'ui', action: 'resume', arg: rt.session.id.slice(0, 8) });
  });
});

describe('context breakdown', () => {
  it('splits the window into system, tools and conversation', async () => {
    fs.writeFileSync(path.join(dir(), 'ALTERAN.md'), '# Project\n' + 'Follow the house style.\n'.repeat(40));
    const { rt } = await makeRuntime([textTurn('ok')]);
    const before = contextBreakdown(rt);
    const part = (r: typeof before, key: string) => r.parts.find((p) => p.key === key)!;
    expect(part(before, 'system').tokens).toBeGreaterThan(100);
    expect(part(before, 'instructions').tokens).toBeGreaterThan(50);
    expect(part(before, 'tools').tokens).toBeGreaterThan(100);
    expect(part(before, 'messages').tokens).toBe(0);
    // Sections plus free space always account for the whole window.
    expect(before.parts.reduce((s, p) => s + p.tokens, 0)).toBe(before.window);

    await rt.main.send('hello there, this is a prompt', new AbortController().signal);
    const after = contextBreakdown(rt);
    expect(part(after, 'messages').tokens).toBeGreaterThan(0);
    expect(after.used).toBeGreaterThan(before.used);
    expect(after.measured).toBeGreaterThan(0);

    const bar = contextBar(after, 40);
    expect(bar.reduce((n, s) => n + s.text.length, 0)).toBe(40);
    expect(bar.at(-1)!.key).toBe('free');
    const text = formatContext(after);
    expect(text).toContain('system prompt');
    expect(text).toContain('prompt tokens');
  });

  it('is reported by /context in both modes', async () => {
    const { rt } = await makeRuntime([textTurn('ok')]);
    const res = await runSlashCommand(rt, '/context');
    expect(res).toEqual({ kind: 'ui', action: 'context' });
  });
});

describe('agent loop', () => {
  it('runs tools and feeds results back to the model', async () => {
    const { rt, provider, events } = await makeRuntime([
      toolTurn('t1', 'Write', { file_path: 'hello.txt', content: 'hi there' }),
      toolTurn('t2', 'Read', { file_path: 'hello.txt' }),
      textTurn('All set.'),
    ]);
    const out = await rt.main.send('create hello.txt', new AbortController().signal);
    expect(out).toBe('All set.');
    expect(fs.readFileSync(path.join(dir(), 'hello.txt'), 'utf8')).toBe('hi there');

    const lastRequest = provider.requests.at(-1)!;
    const resultBlocks = lastRequest.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(resultBlocks).toHaveLength(2);
    expect(JSON.stringify(resultBlocks[1])).toContain('hi there');
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2);
    expect(events.some((e) => e.type === 'usage' && e.turn.outputTokens > 0)).toBe(true);
  });

  it('reports invalid tool input instead of crashing', async () => {
    const { rt, provider } = await makeRuntime([toolTurn('t1', 'Write', { file_path: 'x.txt' }), textTurn('ok')]);
    await rt.main.send('write', new AbortController().signal);
    const results = provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(JSON.stringify(results[0])).toContain('InputValidationError');
  });

  it('denies writes in plan mode and keeps read-only tools working', async () => {
    const { rt, provider } = await makeRuntime([toolTurn('t1', 'Write', { file_path: 'x.txt', content: 'y' }), textTurn('ok')], 'plan');
    await rt.main.send('write', new AbortController().signal);
    const results = provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(JSON.stringify(results[0])).toContain('Plan mode');
    expect(fs.existsSync(path.join(dir(), 'x.txt'))).toBe(false);
  });

  it('denies unapproved actions in headless default mode with an actionable hint', async () => {
    const { rt, provider } = await makeRuntime([toolTurn('t1', 'Bash', { command: 'rm -rf build' }), textTurn('ok')], 'default');
    await rt.main.send('clean', new AbortController().signal);
    const results = provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(JSON.stringify(results[0])).toContain('Permission required');
  });

  it('creates tracker tasks through tasks_* tools and keeps ready order', async () => {
    const { rt, provider } = await makeRuntime([
      toolTurn('t1', 'tasks_create', {
        issues: [
          { title: 'Phase 1: Core', type: 'epic', priority: 1 },
          { title: 'Task A', parent: 'Phase 1' },
        ],
      }),
      textTurn('created'),
    ]);
    await rt.main.send('plan it', new AbortController().signal);
    const jsonl = path.join(dir(), '.beads', 'issues.jsonl');
    expect(fs.existsSync(jsonl)).toBe(true);
    const created = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(created.some((i) => i.title === 'Phase 1: Core' && i.issue_type === 'epic')).toBe(true);
    const results = provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(JSON.stringify(results[0])).toContain('Created');
    expect(JSON.stringify(results[0])).not.toContain('Failed');
  });

  it('runs a subagent through the Task tool and returns its report', async () => {
    const { rt } = await makeRuntime([
      toolTurn('t1', 'Task', { description: 'check', prompt: 'say hi', subagent_type: 'general-purpose' }),
      textTurn('relayed'),
    ]);
    const provider = rt.registry.get('any') as ScriptedProvider;
    // Subagent turn is served by the same scripted provider: queue its reply.
    provider.turns = [
      toolTurn('t1', 'Task', { description: 'check', prompt: 'say hi', subagent_type: 'general-purpose' }),
      textTurn('subagent report'),
      textTurn('relayed'),
    ];
    const out = await rt.main.send('delegate', new AbortController().signal);
    expect(out).toBe('relayed');
    const toolResults = provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(JSON.stringify(toolResults[0])).toContain('subagent report');
  });

  it('hands a background Task back at once instead of waiting for it', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(
      toolTurn('t1', 'Task', { description: 'scan', prompt: 'scan the repo', subagent_type: 'general-purpose', background: true }),
      textTurn('background report'),
      textTurn('launched'),
    );
    await rt.main.send('delegate', new AbortController().signal);
    // The Task result carries the agent's name, not its findings — that is what background means.
    const launch = JSON.stringify(provider.requests[2].messages.at(-1));
    expect(launch).toContain('in the background');
    expect(launch).not.toContain('background report');
  });

  it('delivers a background report to an orchestrator that has gone idle', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(textTurn('found three things'), textTurn('relayed'));
    const run = rt.agents.spawn({ agentType: 'general-purpose', description: 'scan', prompt: 'scan', parent: rt.main, signal: new AbortController().signal, background: true });
    await run.turn;
    // Nothing was running when it finished, so the report waits for the orchestrator's next turn.
    expect(rt.main.pendingContext.join('\n')).toContain('found three things');
    await rt.main.send('what did it find?', new AbortController().signal);
    expect(JSON.stringify(provider.requests.at(-1)!.messages)).toContain('<task-notification>');
  });

  it('continues an agent with SendMessage instead of starting a new one', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(
      toolTurn('t1', 'Task', { description: 'half one', prompt: 'do the first half', subagent_type: 'general-purpose' }),
      textTurn('first report'),
      toolTurn('t2', 'SendMessage', { to: 'general-purpose-1', message: 'now the second half' }),
      textTurn('second report'),
      textTurn('relayed'),
    );
    const out = await rt.main.send('go', new AbortController().signal);
    expect(out).toBe('relayed');
    expect(rt.agents.list()).toHaveLength(1);
    // The continued agent still has its first exchange, so the orchestrator need not repeat it.
    const resumed = JSON.stringify(provider.requests[3].messages);
    expect(resumed).toContain('do the first half');
    expect(resumed).toContain('first report');
    expect(resumed).toContain('now the second half');
  });

  it('queues a message for an agent that is still working', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('x1', 'Read', { file_path: 'nope.txt' }), textTurn('done'));
    const ac = new AbortController();
    const run = rt.agents.spawn({ agentType: 'general-purpose', description: 'a', prompt: 'work', parent: rt.main, signal: ac.signal, background: true });
    await expect(rt.agents.deliver(run.name, 'prefer the fast path', ac.signal)).resolves.toBe('queued');
    expect(run.agent.pendingContext.join(' ')).toContain('prefer the fast path');
    await run.turn;
  });

  it('budgets nesting by depth instead of forbidding it', async () => {
    const { rt } = await makeRuntime([]);
    const child = new Agent({ runtime: rt, label: 'child', model: rt.model, system: '', parent: rt.main });
    const grandchild = new Agent({ runtime: rt, label: 'grandchild', model: rt.model, system: '', parent: child });
    const names = (a: Agent) => rt.toolsFor(a).map((t) => t.name);
    expect(names(rt.main)).toContain('Task');
    expect(names(child)).toContain('Task');
    expect(names(grandchild)).not.toContain('Task');
    // Talking to the user stays with the orchestrator at every depth.
    expect(names(child)).not.toContain('AskUserQuestion');
  });

  it('honours the tool list an agent definition declares', async () => {
    const { rt } = await makeRuntime([]);
    const explore = new Agent({ runtime: rt, label: 'Explore', def: rt.resolveAgentDef('Explore'), model: rt.model, system: '', parent: rt.main });
    const names = rt.toolsFor(explore).map((t) => t.name);
    expect(names).toContain('Grep');
    // Explore is declared read-only, so it does not get to delegate or to write.
    expect(names).not.toContain('Task');
    expect(names).not.toContain('Write');
  });

  it('refuses to launch past the concurrency limit', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('x1', 'Read', { file_path: 'nope.txt' }), textTurn('done'));
    rt.settings.agents = { maxConcurrent: 1 };
    const ac = new AbortController();
    const req = { agentType: 'general-purpose', description: 'a', prompt: 'work', parent: rt.main, signal: ac.signal, background: true };
    const run = rt.agents.spawn(req);
    expect(() => rt.agents.spawn({ ...req, description: 'b' })).toThrow(/already running/);
    await run.turn;
  });

  it('stops one agent without touching the others', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(
      toolTurn('x1', 'Read', { file_path: 'nope.txt' }),
      toolTurn('y1', 'Read', { file_path: 'nope.txt' }),
      textTurn('survivor'),
    );
    const ac = new AbortController();
    const req = { agentType: 'general-purpose', description: 'a', prompt: 'work', parent: rt.main, signal: ac.signal, background: true };
    const doomed = rt.agents.spawn(req);
    const other = rt.agents.spawn({ ...req, description: 'b' });
    rt.agents.stop(doomed.name);
    expect((await doomed.turn).state).toBe('stopped');
    expect((await other.turn).state).toBe('done');
  });

  it('writes each agent transcript beside the session', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(
      toolTurn('t1', 'Task', { description: 'check', prompt: 'look around', subagent_type: 'general-purpose' }),
      textTurn('agent report'),
      textTurn('relayed'),
    );
    await rt.main.send('delegate', new AbortController().signal);
    const file = path.join(SessionStore.agentDir(rt.root, rt.session.id), 'general-purpose-1.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const { messages } = SessionStore.load(file);
    expect(JSON.stringify(messages)).toContain('look around');
    expect(JSON.stringify(messages)).toContain('agent report');
  });

  it('stops cleanly when interrupted', async () => {
    const { rt } = await makeRuntime([toolTurn('t1', 'Read', { file_path: 'nope.txt' }), textTurn('ok')]);
    const ac = new AbortController();
    ac.abort();
    await expect(rt.main.send('go', ac.signal)).rejects.toThrow(/Interrupted/);
  });

  it('persists the session transcript and can resume it', async () => {
    const { rt } = await makeRuntime([textTurn('remembered')]);
    await rt.main.send('remember this', new AbortController().signal);
    const file = rt.session.file;
    expect(fs.readFileSync(file, 'utf8')).toContain('remember this');
    const rt2 = await Runtime.create({ cwd: dir(), noMcp: true, model: 'ollama:test', resume: 'last' });
    expect(JSON.stringify(rt2.main.messages)).toContain('remember this');
  });
});

describe('provider failures', () => {
  /** A provider that fails the first `failures` calls, then defers to the script. */
  const flaky = (inner: ScriptedProvider, failures: number, make: () => Error) => {
    let calls = 0;
    const provider = {
      id: 'flaky',
      async *stream(req: ProviderRequest) {
        if (calls++ < failures) throw make();
        yield* inner.stream(req);
      },
      calls: () => calls,
    };
    return provider;
  };

  const status = (code: number, message: string) => () => Object.assign(new Error(message), { status: code });

  it('retries a gateway that fumbles a tool call instead of ending the turn', async () => {
    const { rt, provider } = await makeRuntime([textTurn('recovered')]);
    // What polza answers when the model emits a tool call it cannot parse — in its own language.
    const f = flaky(provider, 1, status(400, 'Провайдер вернул некорректный вызов инструмента.'));
    rt.registry.get = () => f;
    expect(await rt.main.send('go', new AbortController().signal)).toBe('recovered');
    expect(f.calls()).toBe(2);
  }, 20000);

  it('retries a timeout, and a subagent survives one too', async () => {
    const { rt, provider } = await makeRuntime([textTurn('found it')]);
    const f = flaky(provider, 1, () => new Error('Request timed out.'));
    rt.registry.get = () => f;
    const result = await rt.runSubagent({ agentType: 'general-purpose', description: 'x', prompt: 'x', parent: rt.main, signal: new AbortController().signal });
    expect(result.state).toBe('done');
    expect(result.report).toContain('found it');
  }, 20000);

  it('gives up on an error that retrying cannot fix', async () => {
    const { rt, provider } = await makeRuntime([textTurn('never reached')]);
    const f = flaky(provider, 1, status(401, 'Invalid API key'));
    rt.registry.get = () => f;
    await expect(rt.main.send('go', new AbortController().signal)).rejects.toThrow(/Invalid API key/);
    expect(f.calls()).toBe(1);
  });

  it('stops retrying once the attempts run out', async () => {
    const { rt, provider } = await makeRuntime([textTurn('never reached')]);
    const f = flaky(provider, 99, status(503, 'upstream unavailable'));
    rt.registry.get = () => f;
    await expect(rt.main.send('go', new AbortController().signal)).rejects.toThrow(/unavailable/);
    expect(f.calls()).toBe(4);
  }, 40000);
});

describe('deferred work', () => {
  it('reads the durations a person would type', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('90')).toBe(90_000);
    expect(() => parseDuration('soon')).toThrow(/Cannot read duration/);
  });

  it('delivers a scheduled reminder as a system event, not as the user speaking', async () => {
    const { rt } = await makeRuntime([]);
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    const item = rt.schedule.create({ kind: 'prompt', in: '1s', message: 'check the build' });
    expect(item.state).toBe('waiting');
    const text = await until(() => woken[0]);
    expect(text).toContain('<scheduled-task>');
    expect(text).toContain('not a message from the user');
    expect(text).toContain('check the build');
    expect(rt.schedule.list()[0].state).toBe('done');
  });

  it('delivers a scheduled message to a finished agent', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(textTurn('first pass'), textTurn('second pass'));
    const run = rt.agents.spawn({ agentType: 'general-purpose', description: 'a', prompt: 'look', parent: rt.main, signal: new AbortController().signal, background: true });
    await run.turn;
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    rt.schedule.create({ kind: 'message', in: '1s', to: run.name, message: 'check again' });
    await until(() => JSON.stringify(run.agent.messages).includes('check again'));
    expect(JSON.stringify(run.agent.messages)).toContain('look');
  });

  it('re-arms a repeating item and stops when cancelled', async () => {
    const { rt } = await makeRuntime([]);
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    const item = rt.schedule.create({ kind: 'prompt', in: '1s', every: '1h', message: 'poll it' });
    await until(() => woken.length > 0);
    expect(item.runs).toBe(1);
    expect(item.state).toBe('waiting');
    rt.schedule.cancel(item.id);
    expect(item.state).toBe('cancelled');
  });

  it('never fires a cancelled reminder', async () => {
    const { rt } = await makeRuntime([]);
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    const item = rt.schedule.create({ kind: 'prompt', in: '1s', message: 'should not arrive' });
    rt.schedule.cancel(item.id);
    await new Promise((r) => setTimeout(r, 1300));
    expect(woken).toEqual([]);
    expect(item.state).toBe('cancelled');
  });

  it('lets an agent defer its own check and wakes it when the time comes', async () => {
    const { rt, provider } = await makeRuntime([]);
    rt.ui = {};
    const woken: string[] = [];
    rt.onWake = (_id, text) => woken.push(text);
    provider.turns.push(
      toolTurn('t1', 'Task', { description: 'build', prompt: 'kick off the build', subagent_type: 'general-purpose' }),
      toolTurn('a1', 'Schedule', { kind: 'prompt', in: '1s', message: 'check the build again' }),
      textTurn('build started, will check back'),
      textTurn('relayed'),
      textTurn('build is green'),
    );
    expect(await rt.main.send('build it', new AbortController().signal)).toBe('relayed');

    // The reminder goes back to the agent that set it, with its context intact.
    const resumed = await until(() => provider.requests.find((r) => JSON.stringify(r.messages).includes('<scheduled-task>')));
    const history = JSON.stringify(resumed.messages);
    expect(history).toContain('check the build again');
    expect(history).toContain('kick off the build');
    // What it finds afterwards reaches the orchestrator like any other background report.
    const text = await until(() => woken.find((w) => w.includes('build is green')));
    expect(text).toContain('<task-notification>');
  });

  it('keeps each agent to its own deferred work', async () => {
    const { rt } = await makeRuntime([]);
    const mine = rt.schedule.create({ kind: 'prompt', in: '1h', message: 'orchestrator item' });
    const theirs = rt.schedule.create({ kind: 'prompt', in: '1h', message: 'agent item', owner: 'agent-1', ownerName: 'Explore-1' });
    expect(rt.schedule.list('agent-1').map((i) => i.id)).toEqual([theirs.id]);
    // The orchestrator oversees everything; an agent sees only what it set up.
    expect(rt.schedule.list('main').map((i) => i.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(() => rt.schedule.cancel(mine.id, 'agent-1')).toThrow(/No scheduled item/);
    expect(rt.schedule.cancel(theirs.id, 'agent-1').state).toBe('cancelled');
  });

  it('drops what a stopped agent had deferred', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('x1', 'Read', { file_path: 'nope.txt' }), textTurn('done'));
    const ac = new AbortController();
    const run = rt.agents.spawn({ agentType: 'general-purpose', description: 'a', prompt: 'work', parent: rt.main, signal: ac.signal, background: true });
    const item = rt.schedule.create({ kind: 'prompt', in: '1h', message: 'later', owner: run.agent.id, ownerName: run.name });
    rt.agents.stop(run.name);
    expect(item.state).toBe('cancelled');
    await run.turn;
  });

  it('does not resurrect an item that already ran', async () => {
    const { rt } = await makeRuntime([]);
    rt.onWake = () => {};
    const item = rt.schedule.create({ kind: 'prompt', in: '1s', message: 'once' });
    await until(() => item.state === 'done');
    expect(rt.schedule.cancel(item.id).state).toBe('done');
    expect(item.runs).toBe(1);
  });

  it('refuses to defer work in a run that ends as soon as it answers', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('t1', 'Schedule', { kind: 'prompt', in: '1m', message: 'later' }), textTurn('ok'));
    await rt.main.send('remind me later', new AbortController().signal);
    const result = JSON.stringify(provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')));
    expect(result).toContain('needs an interactive session');
    expect(rt.schedule.list()).toHaveLength(0);
  });
});

describe('prompt cache', () => {
  /**
   * Caching is a prefix match: tools render first, then system, then messages. A request may only
   * ever append to what the previous one sent — anything else throws the whole cache away.
   */
  function expectStablePrefix(requests: ProviderRequest[]) {
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1];
      const next = requests[i];
      expect(JSON.stringify(next.tools), `tools changed before request ${i}`).toBe(JSON.stringify(prev.tools));
      expect(next.system, `system changed before request ${i}`).toBe(prev.system);
      expect(next.reasoning, `reasoning changed before request ${i}`).toBe(prev.reasoning);
      const shared = JSON.stringify(prev.messages);
      const grown = JSON.stringify(next.messages.slice(0, prev.messages.length));
      expect(grown, `history was rewritten before request ${i}`).toBe(shared);
    }
  }

  it('only ever appends to the prefix across a tool loop', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(
      toolTurn('t1', 'Read', { file_path: 'nope.txt' }),
      toolTurn('t2', 'Glob', { pattern: '*.ts' }),
      textTurn('done'),
    );
    await rt.main.send('look around', new AbortController().signal);
    expect(provider.requests.length).toBe(3);
    expectStablePrefix(provider.requests);
  });

  it('keeps the prefix stable across user turns', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(textTurn('one'), textTurn('two'));
    const signal = new AbortController().signal;
    await rt.main.send('first', signal);
    await rt.main.send('second', signal);
    expectStablePrefix(provider.requests);
  });

  it('compacts against the same prefix instead of a fresh one', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(textTurn('hello'), textTurn('SUMMARY'));
    const signal = new AbortController().signal;
    await rt.main.send('remember this', signal);
    await rt.main.compact(signal);
    // The summarizing call is a fork of the same conversation; a different tool list or effort
    // would make it re-read the whole history at full price.
    expectStablePrefix(provider.requests);
  });

  it('reports how much of the prompt came from cache', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push([
      {
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 },
      },
    ]);
    await rt.main.send('go', new AbortController().signal);
    const report = contextBreakdown(rt);
    expect(report.cache).toMatchObject({ read: 900, fresh: 100, ttl: '1h' });
    expect(cacheLine(report)).toContain('90% of prompt tokens read from cache');
    // A dead cache has to say so rather than print a quiet zero.
    expect(cacheLine({ ...report, cache: { read: 0, written: 0, fresh: 1000, ttl: '1h' } })).toContain('nothing is being reused');
  });

  it('gives two agents of the same type the same prefix', async () => {
    const { rt, provider } = await makeRuntime([]);
    const ac = new AbortController();
    const req = { agentType: 'general-purpose', description: 'a', prompt: 'first', parent: rt.main, signal: ac.signal };
    provider.turns.push(textTurn('one'), textTurn('two'));
    const a = await rt.agents.spawn({ ...req }).turn;
    fs.writeFileSync(path.join(dir(), 'moved.txt'), 'the working tree changed between the two');
    const b = await rt.agents.spawn({ ...req, description: 'b', prompt: 'second' }).turn;
    expect(a.state).toBe('done');
    expect(b.state).toBe('done');
    const [first, second] = provider.requests;
    // The git snapshot lives in every agent's system prompt; re-reading it per spawn would cost
    // each agent the other's cached tools and system.
    expect(second.system).toBe(first.system);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  });

  it('changes the roster only when the agent asked for it', async () => {
    const { rt, provider } = await makeRuntime([]);
    // Past thirty MCP tools the roster defers them all, which is what ToolSearch exists to undo.
    const many = Array.from({ length: 31 }, (_, i) => ({
      name: i === 0 ? 'mcp__big__thing' : `mcp__big__filler${i}`,
      description: 'deferred',
      category: 'mcp' as const,
      readOnly: true,
      jsonSchema: { type: 'object', properties: {} },
      run: async () => ok(''),
    }));
    rt.mcp.tools = () => many;
    rt.syncTools();
    provider.turns.push(toolTurn('t1', 'ToolSearch', { query: 'select:mcp__big__thing' }), textTurn('now I can call it'));
    await rt.main.send('load it', new AbortController().signal);
    // Surfacing a deferred tool is a deliberate act, so this invalidation is the one we accept.
    const before = JSON.stringify(provider.requests[0].tools);
    const after = JSON.stringify(provider.requests[1].tools);
    expect(before).not.toContain('mcp__big__thing');
    expect(after).toContain('mcp__big__thing');
  });

  it('holds the tool roster still while a turn is in flight', async () => {
    const { rt, provider } = await makeRuntime([]);
    provider.turns.push(toolTurn('t1', 'Read', { file_path: 'nope.txt' }), textTurn('ok'));
    const extra = { name: 'mcp__late__thing', description: 'arrives mid-turn', category: 'mcp' as const, readOnly: true, jsonSchema: { type: 'object', properties: {} }, run: async () => ok('') };
    // A server that finishes connecting mid-turn must not rewrite the prefix under the model.
    rt.mcp.tools = () => [extra];
    await rt.main.send('go', new AbortController().signal);
    expectStablePrefix(provider.requests);
    // It joins at the next turn boundary instead.
    rt.syncTools();
    expect(rt.toolsFor(rt.main).some((t) => t.name === 'mcp__late__thing')).toBe(true);
  });
});
