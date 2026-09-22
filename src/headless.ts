import type { PermissionMode, Settings } from './config/settings.js';
import { runSlashCommand } from './core/commands.js';
import { contextBreakdown, formatContext } from './core/context.js';
import { SessionStore } from './core/session.js';
import { InterruptedError } from './core/agent.js';
import { Runtime } from './core/runtime.js';
import { paint } from './util/color.js';

export interface HeadlessOptions {
  prompt: string;
  cwd: string;
  model?: string;
  mode?: PermissionMode;
  reasoning?: Settings['reasoning'];
  resume?: string | 'last';
  json?: boolean;
  mcp?: boolean;
  verbose?: boolean;
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const err = (s: string) => (process.stderr.isTTY ? paint.red(s) : s);

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const rt = await Runtime.create({ cwd: opts.cwd, model: opts.model, mode: opts.mode, reasoning: opts.reasoning, resume: opts.resume, noMcp: opts.mcp === false });
  for (const e of rt.settingsErrors) process.stderr.write(`settings: ${e}\n`);
  if (opts.mcp !== false && rt.mcp.servers.size) {
    await Promise.race([rt.connectMcp(), new Promise((r) => setTimeout(r, 15_000))]);
  }
  const controller = new AbortController();
  const onSig = () => controller.abort();
  process.on('SIGINT', onSig);

  let lastWasDelta = false;
  rt.bus.on((ev) => {
    if (opts.json) {
      if (ev.type !== 'text_delta' && ev.type !== 'thinking_delta') process.stdout.write(JSON.stringify(ev) + '\n');
      return;
    }
    switch (ev.type) {
      case 'text_delta':
        if (ev.agentId === 'main') {
          process.stdout.write(ev.text);
          lastWasDelta = true;
        }
        break;
      case 'assistant_message':
        if (ev.agentId === 'main' && lastWasDelta) {
          process.stdout.write('\n');
          lastWasDelta = false;
        }
        break;
      case 'tool_start':
        process.stderr.write(dim(`${ev.agentId === 'main' ? '' : `[${ev.agentId}] `}* ${ev.name}(${ev.summary})\n`));
        break;
      case 'tool_end':
        if (opts.verbose || ev.output.isError) process.stderr.write(dim(`  L ${ev.output.display?.summary ?? ''}${ev.output.isError ? ' [error]' : ''}\n`));
        break;
      case 'agent_start':
        process.stderr.write(dim(`>> agent ${ev.label}\n`));
        break;
      case 'agent_end':
        process.stderr.write(dim(`<< agent ${ev.label} ${ev.ok ? 'done' : 'failed'}\n`));
        break;
      case 'notice':
        process.stderr.write(`${ev.level === 'error' ? err(ev.level) : dim(ev.level)}: ${ev.text}\n`);
        break;
      case 'compact':
        process.stderr.write(dim(`(context compacted)\n`));
        break;
    }
  });

  let code = 0;
  try {
    let prompt = opts.prompt;
    if (prompt.startsWith('/')) {
      const res = await runSlashCommand(rt, prompt);
      if (res.kind === 'ui' && res.action === 'resume') {
        const sessions = SessionStore.list(rt.root);
        const wanted = res.arg ? sessions.find((s) => s.id.startsWith(res.arg!)) : sessions[0];
        if (!wanted) {
          console.error(res.arg ? `No session starts with "${res.arg}"` : 'No saved sessions in this project yet.');
          return 1;
        }
        const { id, messages } = rt.resumeSession(wanted.file);
        console.log(`Resumed session ${id.slice(0, 8)} (${messages} messages)`);
        return code;
      }
      if (res.kind === 'ui' && res.action === 'context') console.log(formatContext(contextBreakdown(rt)));
      else if (res.kind === 'info') console.log(res.text);
      else if (res.kind === 'error') {
        console.error(res.text);
        code = 1;
      } else if (res.kind === 'task') console.log(await res.run(controller.signal));
      else if (res.kind === 'prompt') prompt = res.text;
      if (res.kind !== 'prompt') return code;
    }
    const final = await rt.main.send(prompt, controller.signal);
    if (opts.json) process.stdout.write(JSON.stringify({ type: 'result', text: final, usage: rt.main.usage, session: rt.session.id }) + '\n');
  } catch (e) {
    if (e instanceof InterruptedError) {
      process.stderr.write('\nInterrupted\n');
      code = 130;
    } else {
      process.stderr.write(`\nError: ${(e as Error).message}\n`);
      code = 1;
    }
  } finally {
    process.off('SIGINT', onSig);
    await rt.shutdown();
  }
  return code;
}
