import { textOf } from '../types.js';
import type { AgentEvent } from '../core/events.js';

export type StageState = 'pending' | 'active' | 'done' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  ms: number;
  startedAt?: number;
  count: number;
  detail?: string;
  lastCommand?: string;
}

export type StageKey = 'ctx' | 'plan' | 'read' | 'patch' | 'typecheck' | 'tests' | 'lint' | 'review' | 'commit';

const ORDER: Array<[StageKey, string]> = [
  ['ctx', 'ctx loaded'],
  ['plan', 'plan'],
  ['read', 'read'],
  ['patch', 'patch'],
  ['typecheck', 'typecheck'],
  ['tests', 'unit tests'],
  ['lint', 'lint + format'],
  ['review', 'self-review'],
  ['commit', 'commit + push'],
];

const TYPECHECK =
  /\b(tsc|vue-tsc|mypy|pyright|cargo\s+(check|build)|go\s+(vet|build)|typecheck|type-check|flow\s+check|dotnet\s+build|mvn\s+compile|gradle\s+(build|compile))/;
const TESTS = /\b(test|tests|vitest|jest|pytest|mocha|ava|cargo\s+test|go\s+test|rspec|phpunit|unittest|playwright)\b/;
const LINT = /\b(eslint|lint|prettier|ruff|black|flake8|clippy|rustfmt|gofmt|golangci|biome|stylelint|format)\b/;
const COMMIT = /\bgit\s+(commit|push)\b|\bgh\s+pr\s+create\b/;
const REVIEW = /\bgit\s+(diff|show)\b/;

export interface TestStats {
  passed: number;
  total: number;
  failed: number;
  coverage?: number;
}

/** Pull pass/fail counts and coverage out of common test runner output. */
export function parseTestOutput(out: string): TestStats | undefined {
  let m = out.match(/Tests?:?\s+(?:(\d+)\s+failed[,|\s]+)?(\d+)\s+passed[^\n(]*\((\d+)\)/i);
  let stats: TestStats | undefined;
  if (m) stats = { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
  if (!stats && (m = out.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:\d+\s+\w+,\s+)*(\d+)\s+passed,\s+(\d+)\s+total/i))) {
    stats = { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
  }
  if (!stats && (m = out.match(/=+\s*(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/i))) {
    const failed = Number(m[1] ?? 0);
    stats = { failed, passed: Number(m[2]), total: Number(m[2]) + failed };
  }
  if (!stats && (m = out.match(/test result: \w+\. (\d+) passed; (\d+) failed/))) {
    stats = { passed: Number(m[1]), failed: Number(m[2]), total: Number(m[1]) + Number(m[2]) };
  }
  if (!stats && (m = out.match(/# pass (\d+)[\s\S]*?# fail (\d+)/))) {
    stats = { passed: Number(m[1]), failed: Number(m[2]), total: Number(m[1]) + Number(m[2]) };
  }
  const cov = out.match(/All files\s*\|\s*([\d.]+)/) ?? out.match(/TOTAL\s+\d+\s+\d+\s+(\d+)%/) ?? out.match(/coverage:\s*([\d.]+)%/i);
  if (cov) {
    stats = stats ?? { passed: 0, failed: 0, total: 0 };
    stats.coverage = Number(cov[1]);
  }
  return stats;
}

/** GRADUS: classifies agent activity of the current run into the 9-stage pipeline. */
export class StageTracker {
  stages: Stage[] = [];
  files = { read: new Set<string>(), patched: new Set<string>() };
  tests?: TestStats;
  private running = new Map<string, { key: StageKey; started: number }>();

  constructor() {
    this.reset();
  }

  reset() {
    this.stages = ORDER.map(([key, label]) => ({ key, label, state: 'pending', ms: 0, count: 0 }));
    this.files = { read: new Set(), patched: new Set() };
    this.running.clear();
  }

  get(key: StageKey) {
    return this.stages.find((s) => s.key === key)!;
  }

  /** Number of stages reached (done or active), for "chevron N/9". */
  get locked(): number {
    return this.stages.filter((s) => s.state === 'done' || s.state === 'failed').length;
  }

  private start(key: StageKey, id: string) {
    const st = this.get(key);
    st.state = 'active';
    st.startedAt = Date.now();
    this.running.set(id, { key, started: Date.now() });
  }

  private finish(id: string, failed: boolean) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    const st = this.get(r.key);
    st.ms += Date.now() - r.started;
    st.count++;
    st.state = failed ? 'failed' : 'done';
  }

  classify(name: string, input: Record<string, unknown>): StageKey | undefined {
    if (['Read', 'Glob', 'Grep', 'WebFetch', 'BashOutput'].includes(name) || name.startsWith('mcp__')) return 'read';
    if (['Edit', 'Write', 'MultiEdit'].includes(name)) return 'patch';
    if (name === 'TodoWrite' || name === 'ExitPlanMode' || name.startsWith('tasks_')) return 'plan';
    if (name === 'Bash') {
      const cmd = String(input.command ?? '');
      if (COMMIT.test(cmd)) return 'commit';
      if (TESTS.test(cmd)) return 'tests';
      if (LINT.test(cmd)) return 'lint';
      if (TYPECHECK.test(cmd)) return 'typecheck';
      if (REVIEW.test(cmd)) return 'review';
      return undefined;
    }
    return undefined;
  }

  onEvent(ev: AgentEvent): boolean {
    switch (ev.type) {
      case 'user_message':
        if (ev.agentId === 'main') {
          this.reset();
          const ctx = this.get('ctx');
          ctx.state = 'active';
          ctx.startedAt = Date.now();
          return true;
        }
        return false;
      case 'assistant_message': {
        const ctx = this.get('ctx');
        if (ctx.state === 'active') {
          ctx.state = 'done';
          ctx.ms = Date.now() - (ctx.startedAt ?? Date.now());
        }
        if (ev.agentId === 'main' && !ev.message.content.some((b) => b.type === 'tool_use') && this.get('patch').count > 0) {
          const rv = this.get('review');
          if (rv.state === 'pending') rv.state = 'done';
        }
        return true;
      }
      case 'tool_start': {
        const key = this.classify(ev.name, ev.input);
        if (!key) return false;
        if (key === 'read' && typeof ev.input.file_path === 'string') this.files.read.add(ev.input.file_path);
        if (key === 'patch' && typeof ev.input.file_path === 'string') this.files.patched.add(ev.input.file_path);
        if (key !== 'read' && key !== 'patch' && key !== 'plan') this.get(key).lastCommand = String(ev.input.command ?? '');
        this.start(key, ev.id);
        return true;
      }
      case 'tool_end': {
        const r = this.running.get(ev.id);
        if (!r) return false;
        const out = textOf(ev.output.content);
        let failed = Boolean(ev.output.isError);
        if (r.key === 'tests') {
          const t = parseTestOutput(out);
          if (t) {
            this.tests = { ...this.tests, ...t, coverage: t.coverage ?? this.tests?.coverage };
            failed = t.failed > 0 || failed;
          }
        }
        if (r.key === 'read' || r.key === 'patch') failed = false;
        this.finish(ev.id, failed);
        return true;
      }
      case 'todos': {
        const st = this.get('plan');
        st.detail = `${ev.todos.length} steps`;
        return true;
      }
    }
    return false;
  }

  label(st: Stage): string {
    switch (st.key) {
      case 'plan':
        return st.detail ? `plan ${st.detail}` : 'plan';
      case 'read':
        return `read ${this.files.read.size || st.count} files`;
      case 'patch':
        return `patch ${this.files.patched.size} files`;
      case 'tests':
        return this.tests?.total ? `unit tests ${this.tests.passed}/${this.tests.total}` : 'unit tests';
      default:
        return st.label;
    }
  }
}
