import { spawn } from 'node:child_process';
import type { HookMatcher } from '../config/settings.js';
import { shellPath } from '../tools/bash.js';

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'Notification';

export interface HookSource {
  matchers: HookMatcher[];
  /** Extra env (e.g. CLAUDE_PLUGIN_ROOT for plugin hooks). */
  env?: Record<string, string>;
  origin: string;
}

export interface HookResult {
  /** Block the action (PreToolUse, UserPromptSubmit, Stop → continue). */
  block?: boolean;
  reason?: string;
  permission?: 'allow' | 'deny' | 'ask';
  /** Text to add to the model context. */
  context: string[];
  /** Stop the whole session. */
  stop?: boolean;
  /** Rewritten tool input (PreToolUse updatedInput). */
  updatedInput?: Record<string, unknown>;
  /** Allow rules the hook asked to add (Claude's `updatedPermissions`). */
  updatedPermissions?: string[];
  messages: string[];
}

/**
 * Claude's `updatedPermissions` describes several kinds of permission change; only "add an allow
 * rule" carries something this runner can act on, so anything else is ignored rather than guessed at.
 */
function permissionRules(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (typeof e === 'string') {
      out.push(e);
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const update = e as { behavior?: string; rule?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> };
    if (update.behavior && update.behavior !== 'allow') continue;
    if (typeof update.rule === 'string') {
      out.push(update.rule);
      continue;
    }
    for (const r of update.rules ?? []) {
      if (!r?.toolName) continue;
      out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    }
  }
  return out;
}

function matches(matcher: string | undefined, target: string | undefined): boolean {
  if (!matcher || matcher === '*' || target === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(target);
  } catch {
    return matcher === target;
  }
}

function runCommand(
  command: string,
  payload: unknown,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(shellPath(), ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}

/** Claude Code compatible command hooks (settings.json `hooks`, plugin hooks/hooks.json). */
export class HookRunner {
  constructor(private base: { sessionId: string; transcriptPath: string; cwd: () => string; projectDir: string }) {}

  has(event: HookEvent): boolean {
    return this.forEvent(event).length > 0;
  }

  private eventMap = new Map<HookEvent, Array<{ m: HookMatcher; src: HookSource }>>();

  register(event: HookEvent, matcher: HookMatcher, src: HookSource) {
    const list = this.eventMap.get(event) ?? [];
    list.push({ m: matcher, src });
    this.eventMap.set(event, list);
  }

  private forEvent(event: HookEvent) {
    return this.eventMap.get(event) ?? [];
  }

  async run(event: HookEvent, data: Record<string, unknown>, target?: string): Promise<HookResult> {
    const result: HookResult = { context: [], messages: [] };
    const entries = this.forEvent(event).filter((e) => matches(e.m.matcher, target));
    if (!entries.length) return result;
    const payload = {
      session_id: this.base.sessionId,
      transcript_path: this.base.transcriptPath,
      cwd: this.base.cwd(),
      hook_event_name: event,
      ...data,
    };
    const jobs = entries.flatMap(({ m, src }) =>
      m.hooks
        .filter((h) => (h.type ?? 'command') === 'command' && h.command)
        .map(async (h) => {
          const env = { CLAUDE_PROJECT_DIR: this.base.projectDir, ALTERAN_PROJECT_DIR: this.base.projectDir, ...src.env };
          let command = h.command!;
          for (const [k, v] of Object.entries(src.env ?? {})) command = command.split('${' + k + '}').join(v);
          return runCommand(command, payload, this.base.cwd(), env, (h.timeout ?? 60) * 1000);
        }),
    );
    for (const r of await Promise.all(jobs)) {
      if (r.code === 2) {
        result.block = true;
        result.reason = [result.reason, r.stderr.trim() || 'Blocked by hook'].filter(Boolean).join('\n');
        continue;
      }
      const out = r.stdout.trim();
      if (r.code !== 0) {
        if (r.stderr.trim()) result.messages.push(`hook (${event}) failed: ${r.stderr.trim().slice(0, 300)}`);
        continue;
      }
      if (!out) continue;
      let json: Record<string, any> | null = null;
      if (out.startsWith('{')) {
        try {
          json = JSON.parse(out);
        } catch {}
      }
      if (!json) {
        if (event === 'UserPromptSubmit' || event === 'SessionStart') result.context.push(out);
        continue;
      }
      if (json.continue === false) {
        result.stop = true;
        result.reason = json.stopReason ?? result.reason;
      }
      if (json.decision === 'block') {
        result.block = true;
        result.reason = json.reason ?? result.reason;
      }
      if (json.decision === 'approve') result.permission = 'allow';
      const hso = json.hookSpecificOutput ?? {};
      if (hso.permissionDecision) {
        result.permission = hso.permissionDecision;
        if (hso.permissionDecision === 'deny') result.reason = hso.permissionDecisionReason ?? result.reason;
      }
      if (hso.updatedInput && typeof hso.updatedInput === 'object') result.updatedInput = hso.updatedInput;
      const rules = permissionRules(hso.updatedPermissions);
      if (rules.length) result.updatedPermissions = [...(result.updatedPermissions ?? []), ...rules];
      if (hso.additionalContext) result.context.push(String(hso.additionalContext));
      if (json.systemMessage) result.messages.push(String(json.systemMessage));
    }
    return result;
  }
}

export function buildHookRunner(
  sources: Array<{ hooks: Record<string, HookMatcher[]>; env?: Record<string, string>; origin: string }>,
  base: ConstructorParameters<typeof HookRunner>[0],
): HookRunner {
  const runner = new HookRunner(base);
  for (const s of sources) {
    for (const [event, matchers] of Object.entries(s.hooks)) {
      for (const m of matchers) runner.register(event as HookEvent, m, { matchers: [m], env: s.env, origin: s.origin });
    }
  }
  return runner;
}
