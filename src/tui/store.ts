import type { AgentEvent, TodoItem } from '../core/events.js';
import type { Runtime } from '../core/runtime.js';
import type { ScheduleView } from '../core/schedule.js';
import { contextBreakdown, type ContextReport } from '../core/context.js';
import type { KeyStatus } from '../providers/catalog.js';
import { isClosedStatus } from '../tracker/model.js';
import { TrackerStore } from '../tracker/store.js';
import type { ToolDisplay } from '../tools/types.js';
import { promptTokens } from '../types.js';
import { textOf } from '../types.js';
import { readGit, type GitInfo } from './git.js';
import { setDisplayRoot } from './render.js';
import { StageTracker } from './stages.js';
import { C, type Color } from './theme.js';

export type Entry =
  | { kind: 'user'; text: string; t: number }
  | { kind: 'assistant'; text: string; t: number; live?: boolean }
  | { kind: 'thinking'; text: string; t: number; live?: boolean }
  | {
      kind: 'tool';
      id: string;
      agentId: string;
      agentLabel?: string;
      name: string;
      summary: string;
      input: Record<string, unknown>;
      t: number;
      status: 'running' | 'ok' | 'error';
      display?: ToolDisplay;
      resultText?: string;
      durationMs?: number;
    }
  | {
      kind: 'agent';
      id: string;
      label: string;
      /** Address the orchestrator uses for SendMessage; shown so the user can follow along. */
      name?: string;
      background?: boolean;
      t: number;
      status: AgentState;
      detail?: string;
      summary?: string;
    }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; t: number }
  | { kind: 'info'; text: string; title?: string }
  | { kind: 'error'; text: string }
  | { kind: 'plan'; text: string }
  | { kind: 'diff'; text: string }
  /** Startup screen: stargate art plus the session facts. */
  | { kind: 'splash'; rows: Array<[string, string]>; hints: string[] }
  /** Colour-coded breakdown of the context window (/context). */
  | { kind: 'context'; report: ContextReport };

export type AgentState = 'running' | 'done' | 'failed' | 'stopped';

/** One delegated agent, as the AGENTS panel shows it. */
export interface AgentRow {
  id: string;
  name: string;
  type: string;
  task: string;
  parentId: string;
  depth: number;
  model: string;
  background: boolean;
  state: AgentState;
  detail: string;
  tokens: number;
  startedAt: number;
  endedAt?: number;
}

export interface EventLogItem {
  text: string;
  t: number;
  color: Color;
}

export interface ConsiliumItem {
  mark: string;
  color: Color;
  title: string;
  id: string;
}

export interface ConsiliumView {
  title: string;
  note: string;
  items: ConsiliumItem[];
  source: 'tracker' | 'todos' | 'none';
  current?: string;
}

export class UiStore {
  entries: Array<Entry & { v: number }> = [];
  private seq = 0;
  running = false;
  runStartedAt = Date.now();
  lastRunMs = 0;
  status: { state: string; detail?: string } = { state: 'idle' };
  contextTokens = 0;
  contextWindow = 200_000;
  runTokens = 0;
  sessionTokens = 0;
  /** What this session has been charged, when the gateway reports per-request cost. */
  sessionCost = 0;
  costCurrency = '';
  /** Spend limit / balance of the provider key, refreshed in the background. */
  keyStatus?: KeyStatus;
  /** What the context window is spent on; recomputed after each turn. */
  contextReport?: ContextReport;
  /** [timestamp, tokens] samples for rate and burn graph. */
  samples: Array<[number, number]> = [];
  events: EventLogItem[] = [];
  stages = new StageTracker();
  git?: GitInfo;
  todos: TodoItem[] = [];
  consilium: ConsiliumView = { title: 'tasks', note: '', items: [], source: 'none' };
  lastPrompt = '';
  expanded = false;
  awaiting = false;
  tick = 0;
  agents = new Map<string, string>();
  readonly agentRows = new Map<string, AgentRow>();
  /** Deferred work, newest snapshot from the scheduler. */
  scheduled: ScheduleView[] = [];
  private listeners = new Set<() => void>();
  private pending = false;
  /** How many leading entries are final and may be printed permanently (inline layout). */
  staticCount = 0;
  /** The splash only animates in the panel layout; inline output must be written once and left alone. */
  animateSplash = true;
  /** Bumped by reset(): <Static> counts what it has printed, so it must remount to start over. */
  generation = 0;
  /** Set by the console view; the instruments screen uses it to stop a running turn. */
  interrupt?: () => void;
  private toolEntries = new Map<string, Entry & { v: number; kind: 'tool' }>();
  private liveText?: Entry & { v: number; kind: 'assistant' };
  private liveThinking?: Entry & { v: number; kind: 'thinking' };
  liveEntry = () => this.liveText;
  liveThinkingEntry = () => this.liveThinking;
  private gitTimer?: NodeJS.Timeout;
  private keyTimer?: NodeJS.Timeout;

  constructor(private rt: Runtime) {
    setDisplayRoot(rt.cwd);
    rt.bus.on((ev) => this.onEvent(ev));
    this.refreshConsilium();
    this.refreshGit();
    this.gitTimer = setInterval(() => this.refreshGit(), 5000);
    this.gitTimer.unref();
    void this.refreshKey();
    this.keyTimer = setInterval(() => void this.refreshKey(), 60_000);
    this.keyTimer.unref();
    rt.mcp.onChange(() => this.changed());
    this.contextWindow = rt.registry.info(rt.model).contextWindow;
    // A resumed session brings its spend with it; without this the meter restarts at zero every time.
    const earlier = rt.sessionUsage();
    this.sessionTokens = promptTokens(earlier) + earlier.outputTokens;
    this.sessionCost = earlier.cost ?? 0;
    this.costCurrency = earlier.currency ?? '';
    this.refreshContext();
  }

  /** Drop the transcript. `staticCount` must go with it or already-printed slots swallow new entries. */
  reset() {
    this.entries = [];
    this.staticCount = 0;
    this.generation++;
  }

  /** Recompute the context breakdown (cheap: it walks the current messages once). */
  refreshContext() {
    try {
      this.contextReport = contextBreakdown(this.rt);
    } catch {
      this.contextReport = undefined;
    }
  }

  /** Balance and limits of the current provider key; silently skipped when unsupported. */
  async refreshKey() {
    try {
      const status = await this.rt.catalog.key(this.rt.model.provider);
      if (status) {
        this.keyStatus = status;
        if (!this.costCurrency) this.costCurrency = status.currency;
        this.changed();
      } else if (this.keyStatus) {
        this.keyStatus = undefined;
        this.changed();
      }
    } catch {
      /* balance is informational */
    }
  }

  /**
   * Entries that will never change again, in order. The inline layout hands these to Ink's
   * <Static>, which prints them once into the terminal's own scrollback; everything after the
   * first unfinished entry stays in the live region.
   */
  settle(): Array<Entry & { v: number }> {
    while (this.staticCount < this.entries.length && isFinalEntry(this.entries[this.staticCount], this)) this.staticCount++;
    return this.entries.slice(0, this.staticCount);
  }

  /** Entries still subject to change: streaming text, running tools, running subagents. */
  live(): Array<Entry & { v: number }> {
    return this.entries.slice(this.staticCount);
  }

  dispose() {
    if (this.keyTimer) clearInterval(this.keyTimer);
    if (this.gitTimer) clearInterval(this.gitTimer);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Coalesce bursts of events (streaming deltas) into ~30 fps renders. */
  changed() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      for (const fn of this.listeners) fn();
    }, 33);
  }

  get elapsed() {
    return this.running ? Date.now() - this.runStartedAt : this.lastRunMs;
  }

  rel(t = Date.now()) {
    return Math.max(0, t - this.runStartedAt);
  }

  push(e: Entry) {
    const entry = { ...e, v: ++this.seq } as Entry & { v: number };
    this.entries.push(entry);
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 1500);
    this.changed();
    return entry;
  }

  touch(e: { v: number }) {
    e.v = ++this.seq;
  }

  log(text: string, color: Color = C.text) {
    this.events.unshift({ text, t: Date.now(), color });
    if (this.events.length > 50) this.events.length = 50;
  }

  startRun(prompt: string) {
    this.running = true;
    this.runStartedAt = Date.now();
    this.runTokens = 0;
    this.lastPrompt = prompt;
    this.changed();
  }

  endRun() {
    this.running = false;
    this.lastRunMs = Date.now() - this.runStartedAt;
    this.finalizeLive();
    this.status = { state: 'idle' };
    this.refreshGit();
    this.changed();
  }

  private finalizeLive() {
    if (this.liveText) {
      this.liveText.live = false;
      this.touch(this.liveText);
      this.liveText = undefined;
    }
    if (this.liveThinking) {
      this.liveThinking.live = false;
      this.touch(this.liveThinking);
      this.liveThinking = undefined;
    }
  }

  tokensPerMinute(): number {
    const cutoff = Date.now() - 60_000;
    return this.samples.filter(([t]) => t >= cutoff).reduce((s, [, n]) => s + n, 0);
  }

  /** Token burn per minute bucket, oldest → newest. */
  burnBuckets(count: number, bucketMs = 60_000): number[] {
    const now = Date.now();
    const buckets = new Array(count).fill(0);
    for (const [t, n] of this.samples) {
      const idx = count - 1 - Math.floor((now - t) / bucketMs);
      if (idx >= 0 && idx < count) buckets[idx] += n;
    }
    return buckets;
  }

  refreshGit() {
    readGit(this.rt.cwd)
      .then((g) => {
        this.git = g;
        this.changed();
      })
      .catch(() => {});
  }

  refreshConsilium() {
    const rt = this.rt;
    if (!rt.tracker) {
      const found = TrackerStore.discover(rt.cwd);
      if (found) rt.attachTracker(found);
    }
    const store = rt.tracker;
    if (store) {
      try {
        const epics = store.epics();
        const withActive = epics.find((e) => !isClosedStatus(e.epic.status) && store.children(e.epic.id).some((c) => c.status === 'in_progress'));
        const firstOpen = epics
          .filter((e) => !isClosedStatus(e.epic.status) && e.total > e.closed)
          .sort((a, b) => (TrackerStore.phaseNumber(a.epic) ?? 999) - (TrackerStore.phaseNumber(b.epic) ?? 999))[0];
        const target = withActive ?? firstOpen;
        if (target) {
          const kids = store.children(target.epic.id).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
          const blocked = store.blockInfo();
          const items = kids.map((k) => {
            const closed = isClosedStatus(k.status);
            const prog = k.status === 'in_progress';
            const isBlocked = !closed && !prog && blocked.get(k.id)?.blocked;
            return {
              id: k.id,
              title: k.title,
              mark: closed ? '[x]' : prog ? '[/]' : isBlocked ? '[.]' : '[ ]',
              color: closed ? C.green : prog ? C.amber : isBlocked ? C.dim : C.muted,
            };
          });
          const n = TrackerStore.phaseNumber(target.epic);
          const current = kids.find((k) => k.status === 'in_progress');
          this.consilium = {
            title: n !== undefined ? `phase ${n}` : target.epic.id,
            note: `plan ${target.closed}/${target.total}`,
            items,
            source: 'tracker',
            current: current ? `${current.id}: ${current.title}` : target.epic.title,
          };
          this.changed();
          return;
        }
      } catch {}
    }
    if (this.todos.length) {
      const mark = { completed: '[x]', in_progress: '[/]', pending: '[ ]' } as const;
      const color = { completed: C.green, in_progress: C.amber, pending: C.muted } as const;
      this.consilium = {
        title: 'todos',
        note: `plan ${this.todos.filter((t) => t.status === 'completed').length}/${this.todos.length}`,
        items: this.todos.map((t, i) => ({
          id: String(i),
          title: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content,
          mark: mark[t.status],
          color: color[t.status],
        })),
        source: 'todos',
      };
    } else {
      this.consilium = { title: 'tasks', note: store ? 'no open phases' : 'no tracker', items: [], source: 'none' };
    }
    this.changed();
  }

  /** Delegated agents in tree order: every agent follows the one that launched it. */
  agentTree(): AgentRow[] {
    const byParent = new Map<string, AgentRow[]>();
    for (const r of this.agentRows.values()) {
      const list = byParent.get(r.parentId) ?? [];
      list.push(r);
      byParent.set(r.parentId, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.startedAt - b.startedAt);
    const out: AgentRow[] = [];
    const walk = (parentId: string) => {
      for (const r of byParent.get(parentId) ?? []) {
        out.push(r);
        walk(r.id);
      }
    };
    walk('main');
    for (const r of this.agentRows.values()) if (!out.includes(r)) out.push(r);
    return out;
  }

  private onEvent(ev: AgentEvent) {
    if (this.stages.onEvent(ev)) this.changed();
    switch (ev.type) {
      case 'user_message':
        if (ev.agentId === 'main') {
          this.finalizeLive();
          const text = ev.text.replace(/^<command-name>(\/\S+)<\/command-name>[\s\S]*$/, '$1');
          this.push({ kind: 'user', text, t: this.rel() });
        }
        break;
      case 'text_delta': {
        if (ev.agentId !== 'main') break;
        if (this.liveThinking) {
          this.liveThinking.live = false;
          this.touch(this.liveThinking);
          this.liveThinking = undefined;
        }
        const live = this.liveText ?? (this.push({ kind: 'assistant', text: '', t: this.rel(), live: true }) as Entry & { v: number; kind: 'assistant' });
        this.liveText = live;
        live.text += ev.text;
        this.touch(live);
        this.changed();
        break;
      }
      case 'thinking_delta': {
        if (ev.agentId !== 'main') break;
        const lt = this.liveThinking ?? (this.push({ kind: 'thinking', text: '', t: this.rel(), live: true }) as Entry & { v: number; kind: 'thinking' });
        this.liveThinking = lt;
        lt.text += ev.text;
        this.touch(lt);
        this.changed();
        break;
      }
      case 'assistant_message': {
        if (ev.agentId !== 'main') break;
        const text = ev.message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim();
        if (this.liveText) {
          this.liveText.text = text || this.liveText.text;
          this.liveText.live = false;
          this.touch(this.liveText);
          this.liveText = undefined;
        } else if (text) {
          this.push({ kind: 'assistant', text, t: this.rel() });
        }
        if (this.liveThinking) {
          this.liveThinking.live = false;
          this.touch(this.liveThinking);
          this.liveThinking = undefined;
        }
        break;
      }
      case 'tool_start': {
        if (ev.agentId === 'main') this.finalizeLive();
        const e = this.push({
          kind: 'tool',
          id: ev.id,
          agentId: ev.agentId,
          agentLabel: ev.agentId === 'main' ? undefined : this.agents.get(ev.agentId),
          name: ev.name,
          summary: ev.summary,
          input: ev.input,
          t: this.rel(),
          status: 'running',
        }) as Entry & { v: number; kind: 'tool' };
        this.toolEntries.set(ev.id, e);
        break;
      }
      case 'tool_end': {
        const e = this.toolEntries.get(ev.id);
        if (e) {
          e.status = ev.output.isError ? 'error' : 'ok';
          e.display = ev.output.display;
          e.resultText = textOf(ev.output.content).slice(0, 4000);
          e.durationMs = ev.durationMs;
          e.input = ev.input;
          this.touch(e);
          this.toolEntries.delete(ev.id);
        }
        const short = ev.output.display?.summary ?? '';
        if (['Edit', 'Write', 'MultiEdit', 'Bash'].includes(ev.name)) this.refreshGit();
        if (ev.name.startsWith('tasks_')) this.refreshConsilium();
        if (ev.output.isError) this.log(`${ev.name} failed`, C.red);
        else if (ev.name === 'Bash')
          this.log(
            `${String(ev.input.command ?? '')
              .split(' ')
              .slice(0, 2)
              .join(' ')}  ${short.slice(0, 20)}`,
            C.text,
          );
        else if (ev.name === 'tasks_close') this.log(`closed ${(ev.input.ids as string[] | undefined)?.join(' ') ?? ''}`, C.green);
        else if (['Edit', 'Write', 'MultiEdit'].includes(ev.name))
          this.log(
            `patched ${String(ev.input.file_path ?? '')
              .split('/')
              .pop()}`,
            C.text,
          );
        this.changed();
        break;
      }
      case 'agent_start': {
        const type = ev.label.split(':')[0];
        this.agents.set(ev.agentId, ev.name ?? type);
        const row = this.agentRows.get(ev.agentId);
        if (row) {
          row.state = 'running';
          row.detail = '';
          row.endedAt = undefined;
        } else {
          this.agentRows.set(ev.agentId, {
            id: ev.agentId,
            name: ev.name ?? ev.agentId,
            type,
            task: ev.label.slice(type.length + 2) || type,
            parentId: ev.parentId ?? 'main',
            depth: ev.depth ?? 1,
            model: ev.model ?? '',
            background: Boolean(ev.background),
            state: 'running',
            detail: '',
            tokens: 0,
            startedAt: Date.now(),
          });
        }
        // A continued agent keeps its console entry; only a fresh one opens another.
        const existing = ev.resumed
          ? ([...this.entries].reverse().find((x) => x.kind === 'agent' && x.id === ev.agentId) as (Entry & { v: number; kind: 'agent' }) | undefined)
          : undefined;
        if (existing) {
          existing.status = 'running';
          existing.summary = undefined;
          this.touch(existing);
        } else {
          this.push({ kind: 'agent', id: ev.agentId, label: ev.label, name: ev.name, background: ev.background, t: this.rel(), status: 'running' });
        }
        this.log(`agent ${ev.name ?? type} ${ev.resumed ? 'resumed' : 'started'}`, C.cyan);
        break;
      }
      case 'agent_end': {
        const row = this.agentRows.get(ev.agentId);
        const state: AgentState = ev.ok ? 'done' : row?.state === 'stopped' ? 'stopped' : 'failed';
        if (row) {
          row.state = state;
          row.detail = '';
          row.endedAt = Date.now();
        }
        const e = [...this.entries].reverse().find((x) => x.kind === 'agent' && x.id === ev.agentId) as (Entry & { v: number; kind: 'agent' }) | undefined;
        if (e) {
          e.status = state;
          e.detail = undefined;
          e.summary = ev.summary;
          this.touch(e);
        }
        this.log(`agent ${ev.name ?? ev.label} ${ev.ok ? 'done' : 'failed'}`, ev.ok ? C.green : C.red);
        this.refreshConsilium();
        break;
      }
      case 'usage': {
        const burn = ev.turn.inputTokens + ev.turn.outputTokens + ev.turn.cacheWriteTokens;
        this.samples.push([Date.now(), burn]);
        if (this.samples.length > 5000) this.samples.splice(0, 1000);
        this.runTokens += burn;
        this.sessionTokens += burn;
        if (ev.turn.cost) {
          this.sessionCost += ev.turn.cost;
          this.costCurrency = ev.turn.currency ?? this.costCurrency;
        }
        if (ev.agentId === 'main') {
          this.contextTokens = ev.contextTokens;
          this.contextWindow = ev.contextWindow;
          this.refreshContext();
        } else {
          const row = this.agentRows.get(ev.agentId);
          if (row) row.tokens = ev.total.inputTokens + ev.total.outputTokens;
        }
        this.changed();
        break;
      }
      case 'status': {
        if (ev.agentId === 'main' || this.running) this.status = { state: ev.state, detail: ev.detail };
        const row = this.agentRows.get(ev.agentId);
        if (row && row.state === 'running') {
          row.detail = ev.detail ?? ev.state;
          const e = [...this.entries].reverse().find((x) => x.kind === 'agent' && x.id === ev.agentId) as (Entry & { v: number; kind: 'agent' }) | undefined;
          if (e && e.status === 'running') {
            e.detail = row.detail;
            this.touch(e);
          }
        }
        this.changed();
        break;
      }
      case 'notice':
        this.push({ kind: 'notice', level: ev.level, text: ev.text, t: this.rel() });
        this.log(ev.text.slice(0, 40), ev.level === 'error' ? C.red : ev.level === 'warn' ? C.amber : C.muted);
        break;
      case 'todos':
        if (ev.agentId === 'main') {
          this.todos = ev.todos;
          this.refreshConsilium();
        }
        break;
      case 'schedule':
        this.scheduled = ev.items;
        this.changed();
        break;
      case 'tracker_changed':
        this.refreshConsilium();
        break;
      case 'mode':
        this.log(`mode → ${ev.mode}`, C.cyan);
        this.changed();
        break;
      case 'model':
        this.contextWindow = this.rt.registry.info(this.rt.model).contextWindow;
        this.refreshContext();
        void this.refreshKey();
        this.log(`model → ${ev.model}`, C.cyan);
        this.changed();
        break;
      case 'compact':
        this.push({
          kind: 'notice',
          level: 'info',
          text: `Context compacted (~${Math.round(ev.beforeTokens / 1000)}k → ~${Math.round(ev.afterTokens / 1000)}k tokens)`,
          t: this.rel(),
        });
        if (ev.agentId === 'main') {
          this.contextTokens = ev.afterTokens;
          this.refreshContext();
        }
        this.log('context compacted', C.amber);
        break;
      case 'plan_ready':
        this.push({ kind: 'plan', text: ev.plan });
        this.log('plan ready for review', C.gold);
        break;
    }
  }
}

function isFinalEntry(e: Entry & { v: number }, store: UiStore): boolean {
  if (e === store.liveEntry() || e === store.liveThinkingEntry()) return false;
  if ('live' in e && e.live) return false;
  if (e.kind === 'tool') return e.status !== 'running';
  if (e.kind === 'agent') return e.status !== 'running';
  // The splash animates until the first prompt, so it settles only once work starts — unless the
  // layout never animates it, in which case it is final immediately.
  if (e.kind === 'splash') return !store.animateSplash || store.entries.some((x) => x.kind === 'user');
  return true;
}

/** Everything in an entry a person might search for; commands and diffs included, art excluded. */
export function entryText(e: Entry): string {
  switch (e.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'notice':
    case 'info':
    case 'error':
    case 'plan':
    case 'diff':
      return e.text;
    case 'tool':
      return [e.name, e.summary, e.resultText ?? ''].filter(Boolean).join(' ');
    case 'agent':
      return [e.label, e.name ?? '', e.detail ?? '', e.summary ?? ''].filter(Boolean).join(' ');
    default:
      return '';
  }
}

/** Entry indices whose text contains `query`, case-insensitively. Empty query matches nothing. */
export function searchEntries(entries: readonly Entry[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  entries.forEach((e, i) => {
    if (entryText(e).toLowerCase().includes(needle)) hits.push(i);
  });
  return hits;
}
