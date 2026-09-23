import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { fail, ok, type Tool } from './types.js';
import type { Runtime } from '../core/runtime.js';

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

export function shellPath(): string {
  const s = process.env.SHELL;
  if (s && /(bash|zsh)$/.test(s) && fs.existsSync(s)) return s;
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

export function truncateMiddle(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n... [${s.length - max} characters truncated] ...\n\n${s.slice(-half)}`;
}

export interface BackgroundShell {
  id: string;
  command: string;
  proc: ChildProcess;
  output: string;
  readOffset: number;
  exitCode: number | null;
  startedAt: number;
}

function killTree(proc: ChildProcess) {
  if (proc.pid == null) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => {
    try {
      if (proc.exitCode == null && proc.pid != null) process.kill(-proc.pid, 'SIGKILL');
    } catch {}
  }, 2000).unref();
}

/** Wrap a command so the shell's final directory is persisted between calls. */
function wrap(command: string, cwd: string, cwdFile: string) {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `cd ${q(cwd)} 2>/dev/null || true\n${command}\n__alteran_status=$?\npwd -P > ${q(cwdFile)} 2>/dev/null\nexit $__alteran_status`;
}

export function runShell(
  runtime: Runtime,
  command: string,
  opts: { timeout?: number; signal?: AbortSignal; trackCwd?: boolean; env?: Record<string, string> } = {},
): Promise<{ output: string; code: number | null; timedOut: boolean; interrupted: boolean }> {
  const cwdFile = path.join(os.tmpdir(), `alteran-cwd-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const trackCwd = opts.trackCwd !== false;
  const startCwd = runtime.cwd;
  const script = trackCwd ? wrap(command, startCwd, cwdFile) : command;
  return new Promise((resolve) => {
    const proc = spawn(shellPath(), ['-c', script], {
      cwd: runtime.cwd,
      env: { ...process.env, ...runtime.env, ...opts.env, ALTERAN: '1', CLAUDECODE: '1', GIT_EDITOR: 'true', PAGER: 'cat' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let interrupted = false;
    const onData = (d: Buffer) => {
      if (output.length < MAX_OUTPUT * 20) output += d.toString();
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree(proc);
      },
      Math.min(opts.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT),
    );
    const onAbort = () => {
      interrupted = true;
      killTree(proc);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => {
      output += `\n${e.message}`;
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        const next = fs.readFileSync(cwdFile, 'utf8').trim();
        // The shell keeps its directory between calls, but only for the call that owns the shared
        // cwd: if another one moved it meanwhile, this late `pwd` is stale and must not undo that.
        if (trackCwd && runtime.cwd === startCwd && next && fs.existsSync(next)) runtime.cwd = next;
        fs.rmSync(cwdFile, { force: true });
      } catch {}
      resolve({ output, code, timedOut, interrupted });
    });
  });
}

const bashSchema = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z.number().optional().describe(`Timeout in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})`),
  description: z.string().optional().describe('Clear 5-10 word description of what the command does'),
  run_in_background: z.boolean().optional().describe('Run detached; read output later with BashOutput'),
});

export const BashTool: Tool<z.infer<typeof bashSchema>> = {
  name: 'Bash',
  category: 'bash',
  description: `Executes a shell command and returns combined stdout/stderr.
- The working directory persists between calls (cd works). Prefer absolute paths.
- Use Read/Edit/Write/Glob/Grep instead of cat, sed, find and grep.
- Quote paths containing spaces. Chain dependent commands with &&.
- Long-running servers/watchers: set run_in_background and poll with BashOutput.
- Never run interactive commands (editors, git rebase -i, prompts).`,
  schema: bashSchema,
  summarize: (i) => i.command,
  async run(input, ctx) {
    const rt = ctx.runtime;
    if (input.run_in_background) {
      const id = `bash_${rt.shells.size + 1}`;
      const proc = spawn(shellPath(), ['-c', input.command], {
        cwd: rt.cwd,
        env: { ...process.env, ...rt.env, ALTERAN: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const shell: BackgroundShell = { id, command: input.command, proc, output: '', readOffset: 0, exitCode: null, startedAt: Date.now() };
      const onData = (d: Buffer) => {
        shell.output += d.toString();
        if (shell.output.length > 5_000_000) shell.output = shell.output.slice(-2_000_000);
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.on('close', (code) => (shell.exitCode = code ?? -1));
      rt.shells.set(id, shell);
      return ok(`Command running in background with ID: ${id}. Use BashOutput to read its output.`, {
        summary: `Running in background (${id})`,
      });
    }
    // A deferred run must not move the shared working directory out from under a live turn.
    const r = await runShell(rt, input.command, { timeout: input.timeout, signal: ctx.signal, trackCwd: !ctx.direct });
    let out = truncateMiddle(r.output.trimEnd());
    if (r.timedOut) out += `\n[Command timed out after ${input.timeout ?? DEFAULT_TIMEOUT}ms]`;
    if (r.interrupted) out += '\n[Interrupted by user]';
    if (r.code && r.code !== 0 && !r.timedOut && !r.interrupted) out += `\n[exit code ${r.code}]`;
    const lines = out.split('\n');
    return {
      content: out || '(no output)',
      isError: Boolean(r.code) || r.timedOut,
      display: {
        summary: firstMeaningful(lines) ?? (r.code ? `exit code ${r.code}` : '(no output)'),
        lines: lines.slice(-40),
      },
    };
  },
};

function firstMeaningful(lines: string[]) {
  const l = lines.find((x) => x.trim());
  return l ? (l.length > 160 ? l.slice(0, 157) + '...' : l) : undefined;
}

export const BashOutputTool: Tool<{ bash_id: string; filter?: string }> = {
  name: 'BashOutput',
  category: 'read',
  readOnly: true,
  description: 'Returns new output from a background shell started with Bash run_in_background, plus its status.',
  schema: z.object({
    bash_id: z.string().describe('ID of the background shell'),
    filter: z.string().optional().describe('Optional regex; only matching lines are returned'),
  }),
  summarize: (i) => i.bash_id,
  async run(input, ctx) {
    const sh = ctx.runtime.shells.get(input.bash_id);
    if (!sh) return fail(`No background shell ${input.bash_id}`);
    let chunk = sh.output.slice(sh.readOffset);
    sh.readOffset = sh.output.length;
    if (input.filter) {
      const re = new RegExp(input.filter);
      chunk = chunk
        .split('\n')
        .filter((l) => re.test(l))
        .join('\n');
    }
    const status = sh.exitCode == null ? 'running' : `exited with code ${sh.exitCode}`;
    return ok(`<status>${status}</status>\n<output>\n${truncateMiddle(chunk)}\n</output>`, { summary: status });
  },
};

export const KillShellTool: Tool<{ shell_id: string }> = {
  name: 'KillShell',
  category: 'bash',
  description: 'Kills a background shell by ID.',
  schema: z.object({ shell_id: z.string() }),
  summarize: (i) => i.shell_id,
  async run(input, ctx) {
    const sh = ctx.runtime.shells.get(input.shell_id);
    if (!sh) return fail(`No background shell ${input.shell_id}`);
    killTree(sh.proc);
    ctx.runtime.shells.delete(input.shell_id);
    return ok(`Killed ${input.shell_id}`, { summary: `Killed ${input.shell_id}` });
  },
};

export function killAllShells(runtime: Runtime) {
  for (const sh of runtime.shells.values()) killTree(sh.proc);
  runtime.shells.clear();
}
