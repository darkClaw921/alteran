import crypto from 'node:crypto';
import type { AgentDef } from '../compat/types.js';
import type { PermissionMode } from '../config/settings.js';
import type { ModelRef } from '../providers/registry.js';
import { INVALID_JSON_KEY } from '../providers/json.js';
import {
  addUsage,
  emptyUsage,
  promptTokens,
  textOf,
  type ContentBlock,
  type Message,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from '../types.js';
import { notification } from './agents.js';
import type { TodoItem } from './events.js';
import type { Runtime } from './runtime.js';
import { isReadOnly, type Tool, type ToolOutput } from '../tools/types.js';
import { toolSpec } from '../tools/schema.js';

export interface AgentHandle {
  id: string;
  label: string;
  def?: AgentDef;
  depth: number;
  todos: TodoItem[];
  surfaced: Set<string>;
  mode(): PermissionMode;
}

export interface AgentOptions {
  runtime: Runtime;
  label: string;
  def?: AgentDef;
  parent?: AgentHandle;
  model: ModelRef;
  system: string;
  mode?: PermissionMode;
}

const MAX_TURNS = 400;

/** Retries per model call, on top of the first attempt. */
const MODEL_RETRIES = 3;

/**
 * Errors worth another attempt: anything that never reached the model (connection reset, timeout),
 * anything the gateway throttled or fumbled (429, 5xx), and the 400 a gateway answers with when the
 * model emitted a tool call it could not parse. That last one is a dice roll in the model's output,
 * not a defect in the request, and re-rolling it is exactly what a person would do by hand.
 */
const TRANSIENT = /timed?\s*out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network|stream ended without|overload|unavailable|rate.?limit/i;
/** Gateways report a mangled tool call with a 400; some of them only in their own language. */
const BAD_TOOL_CALL = /tool[_ ]?call|tool[_ ]?use|invalid json|malformed|вызов инструмента|некорректн/i;

function transient(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const msg = err?.message ?? String(e);
  if (status === undefined) return TRANSIENT.test(msg);
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  if (status === 400) return BAD_TOOL_CALL.test(msg);
  return false;
}

/** Exponential with jitter, so several agents retrying at once do not march in step. */
function backoffMs(attempt: number, e: unknown): number {
  const after = Number((e as { headers?: Record<string, string> })?.headers?.['retry-after']);
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 30_000);
  return Math.round(Math.min(1000 * 2 ** attempt, 15_000) * (0.75 + Math.random() * 0.5));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new InterruptedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
let agentSeq = 0;
let directSeq = 0;

export class InterruptedError extends Error {
  constructor() {
    super('Interrupted by user');
  }
}

export class Agent implements AgentHandle {
  readonly id: string;
  readonly label: string;
  readonly def?: AgentDef;
  readonly depth: number;
  readonly runtime: Runtime;
  messages: Message[] = [];
  todos: TodoItem[] = [];
  surfaced = new Set<string>();
  model: ModelRef;
  system: string;
  usage: Usage = emptyUsage();
  contextTokens = 0;
  /** Extra context delivered with the next user message (hook output, mode changes, phase reports). */
  pendingContext: string[] = [];
  /** True while a turn is in flight, so the runtime knows whether it must wake this agent. */
  busy = false;
  private modeOverride?: PermissionMode;
  onMessage?: (m: Message) => void;

  constructor(opts: AgentOptions) {
    this.runtime = opts.runtime;
    this.id = opts.parent ? `agent-${++agentSeq}` : 'main';
    this.label = opts.label;
    this.def = opts.def;
    this.depth = opts.parent ? opts.parent.depth + 1 : 0;
    this.model = opts.model;
    this.system = opts.system;
    this.modeOverride = opts.mode;
  }

  mode(): PermissionMode {
    const global = this.runtime.permissions.mode;
    if (global === 'plan') return 'plan';
    return this.modeOverride ?? global;
  }

  get isMain() {
    return this.depth === 0;
  }

  private push(m: Message) {
    this.messages.push(m);
    this.onMessage?.(m);
  }

  private reminder(texts: string[]): ContentBlock[] {
    return texts.filter(Boolean).map((t) => ({ type: 'text', text: `<system-reminder>\n${t}\n</system-reminder>` }));
  }

  /** Run one user turn to completion (model ↔ tools loop). Returns the final assistant text. */
  async send(input: string | ContentBlock[], signal: AbortSignal): Promise<string> {
    const rt = this.runtime;
    // A turn boundary is the one safe moment to let newly connected servers into the tool roster.
    rt.syncTools();
    const text = typeof input === 'string' ? input : textOf(input);
    const extra = [...this.pendingContext];
    this.pendingContext = [];
    if (this.isMain) {
      const hook = await rt.hooks.run('UserPromptSubmit', { prompt: text });
      if (hook.block) {
        rt.bus.emit({ type: 'notice', level: 'warn', text: `Prompt blocked by hook: ${hook.reason ?? ''}` });
        return '';
      }
      extra.push(...hook.context);
      for (const m of hook.messages) rt.bus.emit({ type: 'notice', level: 'info', text: m });
    }
    const content: ContentBlock[] = [...this.reminder(extra), ...(typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input)];
    this.push({ role: 'user', content });
    rt.bus.emit({ type: 'user_message', agentId: this.id, text });
    return this.loop(signal);
  }

  private async loop(signal: AbortSignal): Promise<string> {
    this.busy = true;
    try {
      return await this.turns(signal);
    } finally {
      this.busy = false;
      // A background child can finish between the last drain and this line, when `busy` still says
      // "mid-turn" and nothing will look again. Ask once more now that the turn is truly over.
      this.runtime.wake(this.id);
    }
  }

  private async turns(signal: AbortSignal): Promise<string> {
    const rt = this.runtime;
    let finalText = '';
    let compactedForOverflow = false;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) throw new InterruptedError();
      const info = rt.registry.info(this.model);
      if (this.contextTokens > info.contextWindow * rt.compactThreshold) await this.compact(signal);

      const tools = rt.toolsFor(this);
      rt.bus.emit({ type: 'status', agentId: this.id, state: 'thinking' });
      let result: { message: Message; stopReason: StopReason; usage: Usage };
      try {
        result = await this.callWithRetry(tools, signal);
      } catch (e) {
        if (signal.aborted) throw new InterruptedError();
        const msg = (e as Error).message ?? String(e);
        if (!compactedForOverflow && /context|too long|maximum.*tokens|prompt is too long/i.test(msg) && this.messages.length > 2) {
          compactedForOverflow = true;
          await this.compact(signal);
          continue;
        }
        throw e;
      }
      compactedForOverflow = false;
      const { message, stopReason, usage } = result;
      this.usage = addUsage(this.usage, usage);
      this.contextTokens = promptTokens(usage) + usage.outputTokens;
      rt.bus.emit({
        type: 'usage',
        agentId: this.id,
        model: this.model.id,
        turn: usage,
        total: this.usage,
        contextTokens: this.contextTokens,
        contextWindow: info.contextWindow,
      });

      if (!message.content.length) message.content.push({ type: 'text', text: '(no response)' });
      this.push(message);
      rt.bus.emit({ type: 'assistant_message', agentId: this.id, message });
      const texts = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
      if (texts.length) finalText = texts.join('\n');

      const uses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        if (stopReason === 'max_tokens') {
          this.push({ role: 'user', content: this.reminder(['Your response hit the output token limit. Continue exactly where you left off.']) });
          continue;
        }
        if (stopReason === 'refusal') rt.bus.emit({ type: 'notice', level: 'warn', text: 'The model declined this request.' });
        const stop = await rt.hooks.run(this.isMain ? 'Stop' : 'SubagentStop', { stop_hook_active: turn > 0 });
        if (stop.block && stop.reason) {
          this.push({ role: 'user', content: this.reminder([`Stop hook feedback:\n${stop.reason}`]) });
          continue;
        }
        // A background agent that finished while this turn ran must be reported before the turn ends,
        // or its work would sit unread until the user happened to type again.
        const late = this.drain();
        if (late.length) {
          this.push({ role: 'user', content: this.reminder(late) });
          continue;
        }
        rt.bus.emit({ type: 'status', agentId: this.id, state: 'idle' });
        return finalText;
      }

      const results = await this.runTools(uses, signal);
      const reminders: string[] = [];
      if (this.modeNotice) {
        reminders.push(this.modeNotice);
        this.modeNotice = undefined;
      }
      // Messages sent to this agent mid-run, and reports from its own background children.
      if (this.pendingContext.length) {
        reminders.push(...this.pendingContext);
        this.pendingContext = [];
      }
      reminders.push(...this.drain());
      this.push({ role: 'user', content: [...results, ...this.reminder(reminders)] });
      if (signal.aborted) throw new InterruptedError();
    }
    return finalText + '\n[stopped: turn limit reached]';
  }

  modeNotice?: string;

  /** Notifications for background children that finished since the last check. */
  private drain(): string[] {
    const done = this.runtime.agents.drain(this.id);
    return done.length ? [notification(done)] : [];
  }

  /**
   * Identity of the cacheable prefix (tools + system). Providers that route by key — OpenAI's
   * `prompt_cache_key` — use it to keep requests with the same prefix on the same cache, and it is
   * stable across sessions, so a resumed conversation lands where the first one left off.
   */
  private prefixKey(tools: Tool<any>[]): string {
    const names = tools.map((t) => t.name).join(',');
    if (this.keyFor !== names || this.keySystem !== this.system) {
      this.keyFor = names;
      this.keySystem = this.system;
      this.key = 'alteran-' + crypto.createHash('sha1').update(`${this.system}\n${names}`).digest('hex').slice(0, 16);
    }
    return this.key;
  }
  private key = '';
  private keyFor = '';
  private keySystem = '';

  /**
   * A model call that survives the gateway having a bad minute. Until this existed, one timeout or
   * one mangled tool call ended the whole turn and the user had to retype the task; everything the
   * model had already done that turn stayed, but the thread stopped dead.
   */
  private async callWithRetry(tools: Tool<any>[], signal: AbortSignal) {
    const rt = this.runtime;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callModel(tools, signal);
      } catch (e) {
        if (signal.aborted) throw new InterruptedError();
        if (attempt >= MODEL_RETRIES || !transient(e)) throw e;
        const delay = backoffMs(attempt, e);
        const msg = (e as Error).message ?? String(e);
        rt.bus.emit({
          type: 'notice',
          level: 'warn',
          text: `${this.label}: ${msg} — retrying in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${attempt + 2} of ${MODEL_RETRIES + 1}).`,
        });
        rt.bus.emit({ type: 'status', agentId: this.id, state: 'thinking', detail: `retry ${attempt + 1}/${MODEL_RETRIES}` });
        await wait(delay, signal);
      }
    }
  }

  private async callModel(tools: Tool<any>[], signal: AbortSignal) {
    const rt = this.runtime;
    const provider = rt.registry.get(this.model.provider);
    const info = rt.registry.info(this.model);
    const stream = provider.stream({
      model: this.model.model,
      route: rt.registry.route(this.model),
      system: this.system,
      messages: this.messages,
      tools: tools.map(toolSpec),
      maxTokens: Math.min(rt.settings.maxOutputTokens ?? 64_000, info.maxOutput),
      signal,
      reasoning: rt.reasoning,
      cacheTtl: rt.cacheTtl,
      cacheKey: this.prefixKey(tools),
    });
    for await (const ev of stream) {
      if (ev.type === 'text_delta') rt.bus.emit({ type: 'text_delta', agentId: this.id, text: ev.text });
      else if (ev.type === 'thinking_delta') rt.bus.emit({ type: 'thinking_delta', agentId: this.id, text: ev.text });
      else if (ev.type === 'tool_use_start') rt.bus.emit({ type: 'status', agentId: this.id, state: 'streaming', detail: ev.name });
      else if (ev.type === 'done') return { message: ev.message, stopReason: ev.stopReason, usage: ev.usage };
    }
    throw new Error('Model stream ended without a final message');
  }

  private async runTools(uses: ToolUseBlock[], signal: AbortSignal): Promise<ToolResultBlock[]> {
    const rt = this.runtime;
    const results: ToolResultBlock[] = new Array(uses.length);
    let i = 0;
    while (i < uses.length) {
      if (signal.aborted) {
        for (let j = i; j < uses.length; j++) results[j] = interruptedResult(uses[j]);
        break;
      }
      const tool = rt.findTool(uses[i].name, this);
      const parallel = tool && isReadOnly(tool, uses[i].input);
      if (parallel) {
        let j = i;
        while (j < uses.length) {
          const t = rt.findTool(uses[j].name, this);
          if (!t || !isReadOnly(t, uses[j].input)) break;
          j++;
        }
        const batch = uses.slice(i, j);
        const outs = await Promise.all(batch.map((u) => this.runTool(u, signal)));
        outs.forEach((o, k) => (results[i + k] = o));
        i = j;
      } else {
        results[i] = await this.runTool(uses[i], signal);
        i++;
      }
    }
    return results;
  }

  /**
   * Run a tool outside the model loop (scheduled work), through the same hooks, permission checks
   * and console events, so deferred work is never a way around the rules.
   */
  async runDirect(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
    const use: ToolUseBlock = { type: 'tool_use', id: `direct-${++directSeq}`, name, input };
    const result = await this.runTool(use, signal);
    return { content: result.content, isError: result.isError };
  }

  private async runTool(use: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    const rt = this.runtime;
    const started = Date.now();
    const tool = rt.findTool(use.name, this);
    const finish = (out: ToolOutput, input: Record<string, unknown> = use.input): ToolResultBlock => {
      rt.bus.emit({ type: 'tool_end', agentId: this.id, id: use.id, name: use.name, input, output: out, durationMs: Date.now() - started });
      return { type: 'tool_result', toolUseId: use.id, content: out.content, isError: out.isError };
    };
    let input = use.input;
    const summary = tool?.summarize ? safeSummary(tool, input) : '';
    rt.bus.emit({ type: 'tool_start', agentId: this.id, id: use.id, name: use.name, input, summary });
    if (!tool) return finish({ content: `Unknown tool: ${use.name}. It may need to be loaded with ToolSearch first.`, isError: true });
    if (INVALID_JSON_KEY in input) {
      return finish({ content: `Invalid JSON in tool arguments; re-issue the call with valid JSON.`, isError: true });
    }
    if (tool.schema) {
      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ');
        return finish({ content: `InputValidationError: ${issues}`, isError: true });
      }
      input = parsed.data as Record<string, unknown>;
    }

    const pre = await rt.hooks.run('PreToolUse', { tool_name: tool.name, tool_input: input }, tool.name);
    for (const m of pre.messages) rt.bus.emit({ type: 'notice', level: 'info', text: m });
    if (pre.updatedInput) input = pre.updatedInput;
    if (pre.block || pre.permission === 'deny') {
      return finish({ content: `Blocked by PreToolUse hook: ${pre.reason ?? 'denied'}`, isError: true }, input);
    }

    if (pre.permission !== 'allow') {
      let decision = rt.permissions.check(tool, input, rt.cwd, this.mode());
      if (pre.permission === 'ask' && decision.behavior === 'allow') decision = { behavior: 'ask', reason: pre.reason };
      if (decision.behavior === 'deny') return finish({ content: decision.reason, isError: true }, input);
      if (decision.behavior === 'ask') {
        if (!rt.ui?.askPermission) {
          return finish(
            {
              content: `Permission required for ${tool.name} and no interactive user is available. Ask the user to allow it (e.g. add "${decision.suggestion ?? tool.name}" to permissions.allow) or run with --mode autonomous.`,
              isError: true,
            },
            input,
          );
        }
        rt.bus.emit({ type: 'status', agentId: this.id, state: 'tool', detail: `awaiting approval: ${tool.name}` });
        const answer = await rt.ui.askPermission(
          { tool: tool.name, input, summary, reason: decision.reason, suggestion: decision.suggestion, agentLabel: this.label },
          signal,
        );
        if (answer.kind === 'deny') {
          const fb = answer.feedback ? `\nUser feedback: ${answer.feedback}` : '';
          return finish({ content: `The user denied this ${tool.name} call.${fb}\nDo not retry it as-is; adjust your approach or ask.`, isError: true }, input);
        }
        if (answer.kind === 'allow_always') rt.permissions.addAllow(answer.rule);
      }
    }

    rt.bus.emit({ type: 'status', agentId: this.id, state: 'tool', detail: tool.name });
    let out: ToolOutput;
    try {
      out = await tool.run(input, { runtime: rt, agent: this, signal, toolUseId: use.id });
    } catch (e) {
      if (signal.aborted) out = { content: 'Interrupted by user', isError: true };
      else out = { content: `Tool ${tool.name} failed: ${(e as Error).message ?? e}`, isError: true };
    }
    const post = await rt.hooks.run('PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: textOf(out.content).slice(0, 20_000) }, tool.name);
    if (post.block && post.reason) out = appendText(out, `\n\nPostToolUse hook: ${post.reason}`);
    if (post.context.length) out = appendText(out, `\n\n<system-reminder>\n${post.context.join('\n')}\n</system-reminder>`);
    return finish(out, input);
  }

  /** Replace history with a model-written summary so work can continue in a fresh context. */
  async compact(signal: AbortSignal, instructions?: string): Promise<void> {
    const rt = this.runtime;
    if (this.messages.length < 2) return;
    rt.bus.emit({ type: 'status', agentId: this.id, state: 'compacting' });
    await rt.hooks.run('PreCompact', { trigger: instructions ? 'manual' : 'auto', custom_instructions: instructions ?? '' });
    const before = this.contextTokens;
    const prompt = `${COMPACT_PROMPT}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}`;
    const history = [...this.messages];
    const last = history[history.length - 1];
    if (last.role === 'user') history[history.length - 1] = { role: 'user', content: [...last.content, { type: 'text', text: prompt }] };
    else history.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    const provider = rt.registry.get(this.model.provider);
    let summary = '';
    // Summarizing is a fork of this same conversation: it must send the very same tools, system and
    // effort, or the whole history is re-read at full price instead of from the cache.
    for await (const ev of provider.stream({
      model: this.model.model,
      route: rt.registry.route(this.model),
      system: this.system,
      messages: history,
      tools: rt.toolsFor(this).map(toolSpec),
      maxTokens: 16_000,
      signal,
      reasoning: rt.reasoning,
      cacheTtl: rt.cacheTtl,
      cacheKey: this.prefixKey(rt.toolsFor(this)),
    })) {
      if (ev.type === 'done') summary = textOf(ev.message.content);
    }
    if (!summary.trim()) return;
    const todos = this.todos.length ? `\n\nCurrent todo list:\n${this.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}` : '';
    this.messages = [];
    this.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n\n${summary}${todos}\n\nContinue the work from where it left off without asking the user further questions.`,
        },
      ],
    });
    this.contextTokens = Math.round(summary.length / 3.5);
    rt.bus.emit({ type: 'compact', agentId: this.id, beforeTokens: before, afterTokens: this.contextTokens });
    rt.onCompacted?.(this);
  }
}

const COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, so that work can continue in a new context window without losing anything important.
Include:
1. The user's requests and intent, verbatim where it matters.
2. Key technical decisions, constraints and conventions discovered.
3. Files read, created or modified, with the important code details.
4. Errors encountered and how they were fixed.
5. Tracker state: phases/tasks worked on, which are closed, in progress, remaining (with ids).
6. Pending work and the exact next step.
Respond with the summary only, no tool calls.`;

function interruptedResult(u: ToolUseBlock): ToolResultBlock {
  return { type: 'tool_result', toolUseId: u.id, content: 'Interrupted by user', isError: true };
}

function appendText(out: ToolOutput, text: string): ToolOutput {
  if (typeof out.content === 'string') return { ...out, content: out.content + text };
  return { ...out, content: [...out.content, { type: 'text', text }] };
}

function safeSummary(tool: Tool<any>, input: Record<string, unknown>): string {
  try {
    return tool.summarize!(input as never) ?? '';
  } catch {
    return '';
  }
}
