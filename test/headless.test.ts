import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyUsage, type Provider, type ProviderRequest, type StreamEvent } from '../src/types.js';

/**
 * The headless run builds its own Runtime, so the only seam is the provider it resolves for the
 * model. Replacing the module makes `-p` run against a script instead of a network — the same
 * trick the TUI suites use, applied one layer down.
 */
const script: StreamEvent[][] = [];
const seen: ProviderRequest[] = [];
/** Set to make the next stream throw, for the failure path. */
let failWith: string | undefined;

function makeFake(): Provider {
  return {
    id: 'fake',
    async *stream(req: ProviderRequest) {
      seen.push(req);
      if (failWith) throw new Error(failWith);
      const turn = script.shift() ?? [
        { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, stopReason: 'end_turn', usage: emptyUsage() },
      ];
      for (const ev of turn) yield ev;
    },
  };
}

vi.mock('../src/providers/anthropic.js', () => ({ AnthropicProvider: class {} }));
vi.mock('../src/providers/openai-compat.js', () => ({ OpenAICompatProvider: class {} }));
vi.mock('../src/providers/openai-responses.js', () => ({ OpenAIResponsesProvider: class {} }));

const { runHeadless } = await import('../src/headless.js');
const { ProviderRegistry } = await import('../src/providers/registry.js');

let dir: string;
let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'alteran-headless-'));
  home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'alteran-headless-home-'));
  process.env.ALTERAN_HOME = home;
  script.length = 0;
  seen.length = 0;
  failWith = undefined;
  // Every provider id resolves to the same script.
  ProviderRegistry.prototype.get = () => makeFake();
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
  // `console.log` resolves its stream when it is built, not on every call, so it needs its own
  // capture or the command output would look like nothing was printed.
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(' ') + '\n'));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void err.push(args.map(String).join(' ') + '\n'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ALTERAN_HOME;
});

const textTurn = (text: string): StreamEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] }, stopReason: 'end_turn', usage: emptyUsage() },
];

const run = (prompt: string, extra: Record<string, unknown> = {}) => runHeadless({ prompt, cwd: dir, model: 'anthropic:test', mcp: false, ...extra } as never);
const stdout = () => out.join('');
const stderr = () => err.join('');

describe('headless mode', () => {
  it('streams the answer to stdout and exits clean', async () => {
    script.push(textTurn('all done'));
    expect(await run('fix it')).toBe(0);
    expect(stdout()).toBe('all done\n');
  });

  it('keeps tool activity off stdout, so a pipeline reads the answer alone', async () => {
    fs.writeFileSync(path.join(dir, 'answer.txt'), 'the answer is 42');
    script.push(
      [
        {
          type: 'done',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'answer.txt' } }] },
          stopReason: 'tool_use',
          usage: emptyUsage(),
        },
      ],
      textTurn('the answer is 42'),
    );
    expect(await run('read it')).toBe(0);
    expect(stdout()).toBe('the answer is 42\n');
    expect(stderr()).toContain('* Read(answer.txt)');
  });

  it('reports the run as JSON when asked, with usage and session id', async () => {
    script.push(textTurn('all done'));
    expect(await run('fix it', { json: true })).toBe(0);
    const lines = stdout()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // One JSON object per bus event, ending with the result summary.
    expect(lines.some((l) => l.type === 'tool_start' || l.type === 'user_message')).toBe(true);
    const result = lines.find((l) => l.type === 'result')!;
    expect(result.text).toBe('all done');
    expect((result.session as string).length).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({ inputTokens: 0 });
  });

  it('runs a slash command instead of a prompt', async () => {
    expect(await run('/context')).toBe(0);
    expect(stdout()).toContain('Context:');
    expect(stdout()).toContain('system prompt');
    // A slash command is not a prompt, so the model is never called.
    expect(seen).toHaveLength(0);
  });

  it('fails a bad slash command with a non-zero exit code', async () => {
    expect(await run('/definitely-not-a-command')).toBe(1);
    expect(stderr()).toContain('Unknown command');
  });

  it('turns a model failure into an error and a non-zero exit code', async () => {
    failWith = 'the gateway exploded';
    expect(await run('fix it')).toBe(1);
    expect(stderr()).toContain('the gateway exploded');
  });

  it('says how to continue a session that does not exist', async () => {
    expect(await run('x', { resume: 'deadbeef' })).toBe(1);
    expect(stderr() + stdout()).toMatch(/No session/i);
  });

  it('resumes a saved session and reports it', async () => {
    // A first run writes the transcript a second one can continue.
    script.push(textTurn('first'));
    await run('remember this');
    const sessions = fs.readdirSync(path.join(home, 'sessions', fs.readdirSync(path.join(home, 'sessions'))[0]));
    const file = sessions.find((f) => f.endsWith('.jsonl'))!;
    const id = file.replace(/\.jsonl$/, '');

    script.push(textTurn('second'));
    expect(await run('/resume', { resume: undefined })).toBe(0);
    expect(stdout()).toContain('Resumed session');
    expect(stdout()).toContain(id.slice(0, 8));
  });

  it('prints settings errors instead of swallowing them', async () => {
    fs.writeFileSync(path.join(home, 'settings.json'), '{ not json');
    script.push(textTurn('ok'));
    await run('go');
    expect(stderr()).toContain('invalid JSON');
  });
});
