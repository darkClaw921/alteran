import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Runtime } from '../src/core/runtime.js';
import { contextBar, contextBreakdown, formatContext } from '../src/core/context.js';
import { runSlashCommand } from '../src/core/commands.js';
import { mainSystemPrompt } from '../src/core/prompt.js';
import { SessionStore } from '../src/core/session.js';
import type { AgentEvent } from '../src/core/events.js';
import type { Provider, ProviderRequest, StreamEvent } from '../src/types.js';
import { emptyUsage } from '../src/types.js';

/** Provider that replays scripted turns and records the requests it received. */
class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  requests: ProviderRequest[] = [];
  constructor(private turns: StreamEvent[][]) {}
  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const turn = this.turns.shift() ?? [
      { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, stopReason: 'end_turn', usage: emptyUsage() },
    ];
    for (const ev of turn) yield ev;
  }
}

const toolTurn = (id: string, name: string, input: Record<string, unknown>): StreamEvent[] => [
  { type: 'tool_use_start', id, name },
  {
    type: 'done',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

const textTurn = (text: string): StreamEvent[] => [
  { type: 'text_delta', text },
  {
    type: 'done',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stopReason: 'end_turn',
    usage: { inputTokens: 120, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

let dir: string;
let home: string;

async function makeRuntime(turns: StreamEvent[][], mode: 'autonomous' | 'default' | 'plan' = 'autonomous') {
  const rt = await Runtime.create({ cwd: dir, mode, noMcp: true, model: 'ollama:test' });
  const provider = new ScriptedProvider(turns);
  rt.registry.get = () => provider;
  const events: AgentEvent[] = [];
  rt.bus.on((e) => events.push(e));
  return { rt, provider, events };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-agent-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
  process.env.ALTERAN_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ALTERAN_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

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
    fs.writeFileSync(path.join(dir, 'ALTERAN.md'), '# Project\n' + 'Follow the house style.\n'.repeat(40));
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
    expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hi there');

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
    expect(fs.existsSync(path.join(dir, 'x.txt'))).toBe(false);
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
    const jsonl = path.join(dir, '.beads', 'issues.jsonl');
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
    (provider as unknown as { turns: StreamEvent[][] }).turns = [
      toolTurn('t1', 'Task', { description: 'check', prompt: 'say hi', subagent_type: 'general-purpose' }),
      textTurn('subagent report'),
      textTurn('relayed'),
    ];
    const out = await rt.main.send('delegate', new AbortController().signal);
    expect(out).toBe('relayed');
    const toolResults = provider.requests.at(-1)!.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
    expect(JSON.stringify(toolResults[0])).toContain('subagent report');
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
    const rt2 = await Runtime.create({ cwd: dir, noMcp: true, model: 'ollama:test', resume: 'last' });
    expect(JSON.stringify(rt2.main.messages)).toContain('remember this');
  });
});
