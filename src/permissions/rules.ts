import path from 'node:path';
import picomatch from 'picomatch';
import { HOME } from '../config/paths.js';

export interface ParsedRule {
  raw: string;
  tool: string;
  spec?: string;
}

export function parseRule(raw: string): ParsedRule {
  const m = raw.trim().match(/^([^()]+?)(?:\((.*)\))?$/s);
  if (!m) return { raw, tool: raw.trim() };
  return { raw, tool: m[1].trim(), spec: m[2]?.trim() || undefined };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Split a shell command into simple commands on && || ; | and newlines (quote-aware). */
export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map(stripEnvPrefix);
}

function stripEnvPrefix(cmd: string): string {
  return cmd.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(/^(sudo|time|nice|nohup)\s+/, '');
}

function matchBashSpec(spec: string, command: string): boolean {
  const cmd = command.trim();
  if (spec === '*') return true;
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  if (spec.includes('*')) {
    const re = new RegExp(
      '^' +
        spec
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
      's',
    );
    return re.test(cmd);
  }
  return cmd === spec;
}

function matchPathSpec(spec: string, file: string, root: string): boolean {
  let pattern = spec;
  let base = root;
  if (pattern.startsWith('//')) {
    pattern = pattern.slice(1);
    base = '/';
  } else if (pattern.startsWith('~/')) {
    pattern = path.join(HOME, pattern.slice(2));
    base = '/';
  } else if (pattern.startsWith('/')) {
    // Claude semantics: "/x" is relative to the settings root.
    pattern = pattern.slice(1);
  }
  const abs = path.isAbsolute(pattern) ? pattern : path.join(base, pattern);
  const isMatch = picomatch(abs, { dot: true });
  return isMatch(file) || isMatch(file + '/');
}

export interface MatchInput {
  tool: string;
  input: Record<string, unknown>;
  root: string;
  cwd: string;
}

/** For allow rules on Bash, every sub-command must match; for deny/ask, any sub-command. */
export function ruleMatches(rule: ParsedRule, m: MatchInput, mode: 'all' | 'any' = 'all'): boolean {
  const t = rule.tool;
  if (t.startsWith('mcp__')) {
    if (t === m.tool) return true;
    if (t.endsWith('__*')) return m.tool.startsWith(t.slice(0, -1));
    return m.tool.startsWith(t + '__') && t.split('__').length === 2;
  }
  const toolOk = t === m.tool || (t === 'Edit' && EDIT_TOOLS.has(m.tool)) || t === '*';
  if (!toolOk) return false;
  if (!rule.spec) return true;
  if (m.tool === 'Bash') {
    const command = String(m.input.command ?? '');
    const subs = splitCommand(command);
    if (!subs.length) return false;
    // An allow rule must cover every sub-command; deny/ask match if any part does.
    if (mode === 'all') return subs.every((c) => matchBashSpec(rule.spec!, c));
    return matchBashSpec(rule.spec, command) || subs.some((c) => matchBashSpec(rule.spec!, c));
  }
  if (m.tool === 'WebFetch' && rule.spec.startsWith('domain:')) {
    try {
      const host = new URL(String(m.input.url)).hostname;
      const d = rule.spec.slice(7);
      return host === d || host.endsWith('.' + d);
    } catch {
      return false;
    }
  }
  const file = (m.input.file_path ?? m.input.path ?? m.input.notebook_path) as string | undefined;
  if (file) return matchPathSpec(rule.spec, path.resolve(m.cwd, file), m.root);
  return false;
}

const SAFE_BASH = [
  /^(ls|pwd|echo|printf|cat|head|tail|wc|which|whoami|date|tree|file|stat|du|df|env|printenv|uname|basename|dirname|realpath|true|false)\b/,
  /^(rg|grep|egrep|fgrep|ag|fd)\b/,
  /^find\b(?!.*\s-(exec|execdir|delete|ok|fprint))/,
  /^git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files|blame|describe|tag\s*$|stash\s+list|config\s+--get)\b/,
  /^(br|abr)\s+(list|ls|ready|show|blocked|search|stats|status|count|where|epic\s+status|dep\s+(list|tree))\b/,
  /^alteran\s+tasks\s+(list|ls|ready|show|blocked|search|stats|status|count|where|phase|epic\s+status|dep\s+(list|tree))\b/,
  /^(node|python3?|ruby|go|cargo|rustc|npm|pnpm|yarn|bun|deno|java|tsc)\s+(-v|--version)$/,
  /^(npm|pnpm|yarn)\s+(ls|list|outdated|view|why)\b/,
];

/** Read-only shell commands that never need approval (no redirections, no substitutions). */
export function isSafeBash(command: string): boolean {
  if (/[<>]|\$\(|`/.test(command.replace(/2>&1|>\s*\/dev\/null/g, ''))) return false;
  const subs = splitCommand(command);
  return subs.length > 0 && subs.every((c) => SAFE_BASH.some((re) => re.test(c)));
}
