import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fg from 'fast-glob';
import { z } from 'zod';
import { plural } from './diff.js';
import { displayPath, resolvePath } from './fs-tools.js';
import { fail, ok, type Tool } from './types.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/target/**', '**/.venv/**'];

export const GlobTool: Tool<{ pattern: string; path?: string }> = {
  name: 'Glob',
  category: 'read',
  readOnly: true,
  timeoutMs: 30_000,
  description: 'Fast file pattern matching ("**/*.ts", "src/**/*.tsx"). Returns matching paths sorted by modification time (newest first).',
  schema: z.object({
    pattern: z.string().describe('Glob pattern'),
    path: z.string().optional().describe('Directory to search in (default: working directory)'),
  }),
  summarize: (i) => (i.path ? `${i.pattern} in ${i.path}` : i.pattern),
  async run(input, ctx) {
    const base = input.path ? resolvePath(ctx, input.path) : ctx.runtime.cwd;
    if (!fs.existsSync(base)) return fail(`Directory does not exist: ${base}`);
    const files = await fg(input.pattern, { cwd: base, absolute: true, dot: true, ignore: IGNORE, onlyFiles: true, suppressErrors: true });
    const withTime = files.map((f) => {
      let t = 0;
      try {
        t = fs.statSync(f).mtimeMs;
      } catch {}
      return { f, t };
    });
    withTime.sort((a, b) => b.t - a.t);
    const shown = withTime.slice(0, 200).map((x) => x.f);
    if (!shown.length) return ok('No files found', { summary: 'No files found' });
    const extra = files.length > shown.length ? `\n(${files.length - shown.length} more results truncated)` : '';
    return ok(shown.join('\n') + extra, {
      summary: `Found ${plural(files.length, 'file')}`,
      lines: shown.slice(0, 30).map((f) => displayPath(ctx, f)),
    });
  },
};

const grepSchema = z.object({
  pattern: z.string().describe('Regular expression (ripgrep syntax)'),
  path: z.string().optional().describe('File or directory to search (default: working directory)'),
  glob: z.string().optional().describe('Glob filter, e.g. "*.ts" or "*.{ts,tsx}"'),
  type: z.string().optional().describe('ripgrep file type, e.g. js, py, rust'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Default: files_with_matches'),
  '-i': z.boolean().optional().describe('Case insensitive'),
  '-n': z.boolean().optional().describe('Show line numbers (content mode, default true)'),
  '-A': z.number().optional(),
  '-B': z.number().optional(),
  '-C': z.number().optional(),
  multiline: z.boolean().optional(),
  head_limit: z.number().optional().describe('Limit output to first N lines/entries'),
});

function runRg(args: string[], cwd: string, signal: AbortSignal): Promise<{ out: string; code: number; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('rg', args, { cwd, signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      if (out.length < 2_000_000) out += d;
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ out: '', code: 2, err: String(e) }));
    p.on('close', (code) => resolve({ out, code: code ?? 0, err }));
  });
}

export const GrepTool: Tool<z.infer<typeof grepSchema>> = {
  name: 'Grep',
  category: 'read',
  readOnly: true,
  timeoutMs: 60_000,
  description: `Content search built on ripgrep. Supports full regex, glob/type filters and three output modes:
"files_with_matches" (default, paths only), "content" (matching lines, supports -A/-B/-C/-n), "count".
Use this instead of grep/rg in Bash.`,
  schema: grepSchema,
  summarize: (i) => `pattern: ${JSON.stringify(i.pattern)}${i.path ? `, path: ${JSON.stringify(i.path)}` : ''}`,
  async run(input, ctx) {
    const mode = input.output_mode ?? 'files_with_matches';
    const args = ['--color=never', '--hidden', '--max-columns=500', '-g', '!.git', '-g', '!node_modules'];
    if (mode === 'files_with_matches') args.push('-l');
    if (mode === 'count') args.push('-c');
    if (mode === 'content') {
      if (input['-n'] !== false) args.push('-n');
      if (input['-A'] != null) args.push('-A', String(input['-A']));
      if (input['-B'] != null) args.push('-B', String(input['-B']));
      if (input['-C'] != null) args.push('-C', String(input['-C']));
    }
    if (input['-i']) args.push('-i');
    if (input.multiline) args.push('-U', '--multiline-dotall');
    if (input.glob) args.push('-g', input.glob);
    if (input.type) args.push('-t', input.type);
    args.push('-e', input.pattern);
    const target = input.path ? resolvePath(ctx, input.path) : '.';
    args.push(target);
    const r = await runRg(args, ctx.runtime.cwd, ctx.signal);
    if (r.code === 2 && !r.out) return fail(`rg failed: ${r.err.trim() || 'is ripgrep installed?'}`);
    let lines = r.out.split('\n').filter(Boolean);
    const total = lines.length;
    if (input.head_limit) lines = lines.slice(0, input.head_limit);
    else if (lines.length > 500) lines = lines.slice(0, 500);
    if (!lines.length) return ok('No matches found', { summary: 'No matches found' });
    const files = new Set(mode === 'content' ? lines.map((l) => l.split(':')[0]) : lines);
    const summary =
      mode === 'files_with_matches'
        ? `Found ${plural(total, 'file')}`
        : mode === 'count'
          ? `Counted matches in ${plural(total, 'file')}`
          : `Found ${plural(total, 'match')} across ${plural(files.size, 'file')}`;
    const trunc = total > lines.length ? `\n(${total - lines.length} more lines truncated)` : '';
    return ok(lines.join('\n') + trunc, { summary, lines: lines.slice(0, 30) });
  },
};
