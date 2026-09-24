import { textOf } from '../types.js';
import type { Runtime } from './runtime.js';

export type ScheduleKind = 'prompt' | 'command' | 'message';
export type ScheduleState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** Delay before the first run, e.g. `30s`, `10m`, `1h30m`. Mutually exclusive with `at`. */
  in?: string;
  /** Absolute first run, parsed by `Date`. */
  at?: string;
  /** Repeat interval; the next run is counted from the end of the previous one. */
  every?: string;
  command?: string;
  message?: string;
  /** Agent name for `message`; defaults to the orchestrator. */
  to?: string;
  label?: string;
  /** Agent that set this up; its result goes back there, not to whoever happens to be listening. */
  owner?: string;
  ownerName?: string;
}

export interface ScheduledItem {
  id: string;
  kind: ScheduleKind;
  label: string;
  command?: string;
  message?: string;
  to?: string;
  dueAt: number;
  everyMs?: number;
  runs: number;
  state: ScheduleState;
  lastResult?: string;
  owner: string;
  ownerName: string;
}

/** What the UI needs; the timer itself never leaves the scheduler. */
export type ScheduleView = ScheduledItem;

const MIN_DELAY_MS = 1_000;
const MIN_INTERVAL_MS = 5_000;
/** Timers longer than this overflow setTimeout, so long waits are re-armed in chunks. */
const MAX_TIMER_MS = 2_000_000_000;

export function parseDuration(text: string): number {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) throw new Error('Empty duration');
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parts = trimmed.match(/\d+\s*[smhd]/g);
  if (!parts || parts.join('').replace(/\s+/g, '') !== trimmed.replace(/\s+/g, '')) {
    throw new Error(`Cannot read duration "${text}". Use forms like 45s, 10m, 2h, 1h30m.`);
  }
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return parts.reduce((ms, p) => ms + Number(p.slice(0, -1)) * unit[p.trim().slice(-1)], 0);
}

/**
 * Deferred work the agent set up for itself: a command to run later, a message to send an agent
 * later, or a reminder to pick something up later. Everything fires back as a notification, so a
 * scheduled item never silently changes state behind the orchestrator's back.
 */
export class Scheduler {
  private items = new Map<string, ScheduledItem>();
  private timers = new Map<string, NodeJS.Timeout>();
  private seq = 0;
  private controller = new AbortController();

  constructor(private rt: Runtime) {}

  /** Everything, or just what one agent set up — an agent has no business cancelling another's work. */
  list(owner?: string): ScheduleView[] {
    const items = owner && owner !== 'main' ? [...this.items.values()].filter((i) => i.owner === owner) : [...this.items.values()];
    return items.sort((a, b) => {
      const rank = (i: ScheduledItem) => (i.state === 'running' ? 0 : i.state === 'waiting' ? 1 : 2);
      return rank(a) - rank(b) || a.dueAt - b.dueAt;
    });
  }

  find(id: string): ScheduledItem | undefined {
    const key = id.trim().toLowerCase();
    return this.items.get(key) ?? [...this.items.values()].find((i) => i.label.toLowerCase() === key);
  }

  create(spec: ScheduleSpec): ScheduledItem {
    const owner = spec.owner ?? 'main';
    if (spec.in && spec.at) throw new Error('Give either `in` or `at`, not both.');
    let dueAt: number;
    if (spec.at) {
      const t = Date.parse(spec.at);
      if (Number.isNaN(t)) throw new Error(`Cannot read the time "${spec.at}". Use an ISO timestamp like 2026-09-23T18:30.`);
      dueAt = t;
    } else {
      dueAt = Date.now() + Math.max(MIN_DELAY_MS, parseDuration(spec.in ?? '5m'));
    }
    if (dueAt < Date.now() + MIN_DELAY_MS) dueAt = Date.now() + MIN_DELAY_MS;

    const everyMs = spec.every ? Math.max(MIN_INTERVAL_MS, parseDuration(spec.every)) : undefined;
    if (spec.kind === 'command' && !spec.command?.trim()) throw new Error('A scheduled command needs `command`.');
    if (spec.kind !== 'command' && !spec.message?.trim()) throw new Error(`A scheduled ${spec.kind} needs \`message\`.`);
    if (spec.kind === 'message' && spec.to && !this.rt.agents.find(spec.to)) {
      throw new Error(`No agent named "${spec.to}". Use ListAgents to see the running and finished ones.`);
    }

    const id = `s${++this.seq}`;
    const item: ScheduledItem = {
      id,
      kind: spec.kind,
      label: (spec.label ?? spec.command ?? spec.message ?? id).split('\n')[0].slice(0, 60),
      command: spec.command,
      message: spec.message,
      to: spec.to,
      dueAt,
      everyMs,
      runs: 0,
      state: 'waiting',
      owner,
      ownerName: spec.ownerName ?? (owner === 'main' ? 'alteran' : owner),
    };
    this.items.set(id, item);
    this.arm(item);
    this.publish();
    return item;
  }

  cancel(id: string, owner?: string): ScheduledItem {
    const item = this.find(id);
    if (!item || (owner && owner !== 'main' && item.owner !== owner)) {
      const known = this.list(owner)
        .filter((i) => i.state === 'waiting')
        .map((i) => i.id);
      throw new Error(`No scheduled item "${id}".${known.length ? ` Waiting: ${known.join(', ')}.` : ' Nothing is scheduled.'}`);
    }
    this.disarm(item.id);
    // A run already in flight is left alone, but it must not reschedule itself afterwards.
    if (item.state === 'waiting' || item.state === 'running') item.state = 'cancelled';
    this.publish();
    return item;
  }

  /** Drop what an agent deferred — it was stopped, so nothing of its should fire later. */
  cancelOwned(owner: string) {
    for (const item of this.items.values()) {
      if (item.owner !== owner) continue;
      this.disarm(item.id);
      if (item.state === 'waiting' || item.state === 'running') item.state = 'cancelled';
    }
    this.publish();
  }

  /** Stop every timer; running work is left to finish on its own. */
  cancelAll() {
    this.controller.abort();
    this.controller = new AbortController();
    for (const item of this.items.values()) {
      this.disarm(item.id);
      if (item.state === 'waiting') item.state = 'cancelled';
    }
    this.publish();
  }

  private arm(item: ScheduledItem) {
    this.disarm(item.id);
    const wait = Math.max(0, item.dueAt - Date.now());
    const timer = setTimeout(
      () => {
        // Long waits are split into chunks because setTimeout silently fires at once past ~24.8 days.
        if (item.dueAt - Date.now() > 1000) return this.arm(item);
        void this.fire(item);
      },
      Math.min(wait, MAX_TIMER_MS),
    );
    timer.unref?.();
    this.timers.set(item.id, timer);
  }

  private disarm(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private async fire(item: ScheduledItem) {
    this.disarm(item.id);
    if (item.state === 'cancelled') return;
    item.state = 'running';
    item.runs++;
    this.publish();
    const signal = this.controller.signal;
    let result: string;
    let ok = true;
    try {
      result = await this.run(item, signal);
    } catch (e) {
      ok = false;
      result = (e as Error).message ?? String(e);
    }
    item.lastResult = result.slice(0, 2000);
    // Read it back through the map: `cancel` may have fired while the run was in flight.
    if (this.items.get(item.id)?.state === 'cancelled') return;
    if (item.everyMs && !signal.aborted) {
      item.state = 'waiting';
      item.dueAt = Date.now() + item.everyMs;
      this.arm(item);
    } else {
      item.state = ok ? 'done' : 'failed';
    }
    this.publish();
    this.rt.wake(item.owner, notice(item, result, ok));
  }

  private async run(item: ScheduledItem, signal: AbortSignal): Promise<string> {
    if (item.kind === 'prompt') return item.message ?? '';
    if (item.kind === 'command') {
      // Runs as the agent that scheduled it, through the normal tool path: same hooks, same rules.
      const as = this.rt.agents.find(item.owner)?.agent ?? this.rt.main;
      const out = await as.runDirect('Bash', { command: item.command }, signal);
      const text = textOf(out.content).slice(0, 4000);
      if (out.isError) throw new Error(text);
      return text;
    }
    const target = item.to ?? 'main';
    if (target === 'main') return item.message ?? '';
    const res = await this.rt.agents.deliver(target, item.message ?? '', signal);
    if (res === 'queued') return `Agent ${target} is still working; the message was delivered as guidance.`;
    return res.report || '(agent returned no output)';
  }

  private publish() {
    this.rt.bus.emit({ type: 'schedule', items: this.list().map((i) => ({ ...i })) });
  }
}

/** Scheduled work reports as a system event, never as something the user just said. */
function notice(item: ScheduledItem, result: string, ok: boolean): string {
  const what =
    item.kind === 'prompt'
      ? 'A reminder you scheduled is due.'
      : item.kind === 'command'
        ? `The command you scheduled has run${ok ? '' : ' and failed'}.`
        : `The message you scheduled for ${item.to ?? 'yourself'} was delivered.`;
  return [
    '<scheduled-task>',
    `This is an automated scheduled event, not a message from the user. ${what}`,
    `<id>${item.id}</id>`,
    `<label>${item.label}</label>`,
    item.command ? `<command>${item.command}</command>` : '',
    item.everyMs ? `<repeats>every ${Math.round(item.everyMs / 1000)}s, run ${item.runs}</repeats>` : '',
    '<result>',
    result.trim() || '(no output)',
    '</result>',
    '</scheduled-task>',
  ]
    .filter(Boolean)
    .join('\n');
}
