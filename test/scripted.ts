import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/core/events.js';
import { Runtime } from '../src/core/runtime.js';
import type { PermissionMode } from '../src/config/settings.js';
import type { Provider, ProviderRequest, StreamEvent } from '../src/types.js';
import { emptyUsage } from '../src/types.js';

/** Provider that replays scripted turns and records the requests it received. */
export class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  requests: ProviderRequest[] = [];
  constructor(public turns: StreamEvent[][]) {}
  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const turn = this.turns.shift() ?? [
      { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, stopReason: 'end_turn', usage: emptyUsage() },
    ];
    for (const ev of turn) yield ev;
  }
}

export const toolTurn = (id: string, name: string, input: Record<string, unknown>): StreamEvent[] => [
  { type: 'tool_use_start', id, name },
  {
    type: 'done',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

export const textTurn = (text: string): StreamEvent[] => [
  { type: 'text_delta', text },
  {
    type: 'done',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stopReason: 'end_turn',
    usage: { inputTokens: 120, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

export interface TempDirs {
  /** Working directory of the runtime under test. */
  dir: string;
  /** Stands in for ~/.alteran, so nothing touches the real one. */
  home: string;
}

/** Fresh working directory and fake home per test, with the ecosystem loaders pointed at them. */
export function useTempDirs(prefix: string): TempDirs {
  const dirs: TempDirs = { dir: '', home: '' };
  beforeEach(() => {
    dirs.dir = fs.mkdtempSync(path.join(os.tmpdir(), `alteran-${prefix}-`));
    dirs.home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
    process.env.ALTERAN_HOME = dirs.home;
    process.env.CLAUDE_CONFIG_DIR = path.join(dirs.home, 'claude');
    process.env.CODEX_HOME = path.join(dirs.home, 'codex');
  });
  afterEach(() => {
    fs.rmSync(dirs.dir, { recursive: true, force: true });
    fs.rmSync(dirs.home, { recursive: true, force: true });
    delete process.env.ALTERAN_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  });
  return dirs;
}

export interface ScriptedRuntime {
  rt: Runtime;
  provider: ScriptedProvider;
  events: AgentEvent[];
}

/** A runtime whose model is a script and whose events are collected; no network, no MCP. */
export async function makeRuntime(dirs: TempDirs, turns: StreamEvent[][], mode: PermissionMode = 'autonomous'): Promise<ScriptedRuntime> {
  const rt = await Runtime.create({ cwd: dirs.dir, mode, noMcp: true, model: 'ollama:test' });
  const provider = new ScriptedProvider(turns);
  rt.registry.get = () => provider;
  const events: AgentEvent[] = [];
  rt.bus.on((e) => events.push(e));
  return { rt, provider, events };
}

/** Poll instead of sleeping a fixed time: timers and background turns settle on their own schedule. */
export async function until<T>(probe: () => T | undefined | false, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition still unmet');
    await new Promise((r) => setTimeout(r, 20));
  }
}
