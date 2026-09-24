import path from 'node:path';
import type { PermissionMode } from '../config/settings.js';
import type { Tool } from '../tools/types.js';
import { isReadOnly } from '../tools/types.js';
import { isSafeBash, parseRule, ruleMatches, splitCommand, type ParsedRule } from './rules.js';

export type Decision =
  | { behavior: 'allow'; reason?: string }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason?: string; suggestion?: string };

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  reason?: string;
  /** Suggested rule for "always allow". */
  suggestion?: string;
  agentLabel: string;
}

export type PermissionAnswer = { kind: 'allow_once' } | { kind: 'allow_always'; rule: string } | { kind: 'deny'; feedback?: string };

export interface RuleSources {
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: string[];
}

export class Permissions {
  private allow: ParsedRule[];
  private deny: ParsedRule[];
  private ask: ParsedRule[];
  readonly sessionAllow: string[] = [];

  constructor(
    rules: RuleSources,
    public mode: PermissionMode,
    private root: string,
  ) {
    this.allow = rules.allow.map(parseRule);
    this.deny = rules.deny.map(parseRule);
    this.ask = rules.ask.map(parseRule);
    this.dirs = [root, ...rules.additionalDirectories.map((d) => path.resolve(root, d))];
  }

  private dirs: string[];

  get rules() {
    return { allow: this.allow.map((r) => r.raw), deny: this.deny.map((r) => r.raw), ask: this.ask.map((r) => r.raw) };
  }

  addAllow(rule: string) {
    this.allow.push(parseRule(rule));
    this.sessionAllow.push(rule);
  }

  insideWorkspace(file: string): boolean {
    const abs = path.resolve(file);
    return this.dirs.some((d) => abs === d || abs.startsWith(d + path.sep));
  }

  check(tool: Tool<any>, input: Record<string, unknown>, cwd: string, mode: PermissionMode = this.mode): Decision {
    const m = { tool: tool.name, input, root: this.root, cwd };
    const denied = this.deny.find((r) => ruleMatches(r, m, 'any'));
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.raw}` };

    const readOnly = isReadOnly(tool, input) || (tool.name === 'Bash' && isSafeBash(String(input.command ?? '')));
    if (mode === 'plan' && !readOnly && tool.category !== 'meta' && tool.name !== 'Task') {
      return {
        behavior: 'deny',
        reason: 'Plan mode is active: only read-only tools are allowed. Finish the plan and call ExitPlanMode for approval.',
      };
    }
    const asked = this.ask.find((r) => ruleMatches(r, m, 'any'));
    if (asked && mode !== 'autonomous') return { behavior: 'ask', reason: `Rule ${asked.raw} requires approval` };
    if (readOnly || tool.category === 'meta' || tool.category === 'tasks') return { behavior: 'allow' };
    if (this.allow.some((r) => ruleMatches(r, m, 'all'))) return { behavior: 'allow' };
    if (mode === 'autonomous') return { behavior: 'allow' };
    if (mode === 'acceptEdits' && tool.category === 'write') {
      const file = input.file_path as string | undefined;
      if (file && this.insideWorkspace(path.resolve(cwd, file))) return { behavior: 'allow' };
    }
    return { behavior: 'ask', suggestion: suggestRule(tool.name, input, cwd, this.root) };
  }

  /** Condensed state for the CLIPEUS panel. */
  shield(): Array<{ label: string; state: 'on' | 'partial' | 'off'; text: string }> {
    const bashAllow = this.allow
      .filter((r) => r.tool === 'Bash')
      .map((r) => (r.spec ?? '*').replace(/:\*$/, '').split(' ')[0])
      .filter((v, i, a) => a.indexOf(v) === i);
    const webAllowed = this.allow.some((r) => r.tool === 'WebFetch');
    const auto = this.mode === 'autonomous';
    return [
      {
        label: 'WRITE',
        state: auto || this.mode === 'acceptEdits' ? 'on' : this.mode === 'plan' ? 'off' : 'partial',
        text: this.mode === 'plan' ? 'blocked - plan mode' : auto ? 'all paths' : this.mode === 'acceptEdits' ? 'repo only (auto)' : 'ask per edit',
      },
      {
        label: 'BASH',
        state: auto ? 'on' : bashAllow.length ? 'partial' : 'off',
        text: auto ? 'unrestricted' : bashAllow.length ? `allowlist: ${bashAllow.slice(0, 5).join(' ')}` : 'read-only auto, rest ask',
      },
      {
        label: 'NETWORK',
        state: auto || webAllowed ? 'on' : 'off',
        text: auto ? 'open' : webAllowed ? 'allowlisted domains' : 'ask to open',
      },
      {
        label: 'APPROVE',
        state: auto ? 'on' : this.mode === 'acceptEdits' ? 'partial' : 'off',
        text: { default: 'manual', acceptEdits: 'auto for edits', plan: 'plan review', autonomous: 'autonomous' }[this.mode],
      },
    ];
  }
}

function suggestRule(tool: string, input: Record<string, unknown>, cwd: string, root: string): string {
  if (tool === 'Bash') {
    const first = splitCommand(String(input.command ?? ''))[0] ?? '';
    const words = first.split(/\s+/);
    const prefix = ['npm', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'make', 'docker', 'npx', 'uv', 'poetry'].includes(words[0])
      ? words.slice(0, 2).join(' ')
      : words[0];
    return `Bash(${prefix}:*)`;
  }
  if (tool === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(String(input.url)).hostname})`;
    } catch {
      return 'WebFetch';
    }
  }
  const file = input.file_path as string | undefined;
  if (file) {
    const rel = path.relative(root, path.resolve(cwd, file));
    const dir = path.dirname(rel);
    if (!rel.startsWith('..')) return `Edit(${dir === '.' ? '' : dir + '/'}**)`;
  }
  return tool;
}
