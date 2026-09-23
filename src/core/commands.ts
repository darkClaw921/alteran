import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../compat/frontmatter.js';
import type { CommandDef } from '../compat/types.js';
import { PermissionModeSchema, updateUserSettings, type PermissionMode } from '../config/settings.js';
import { epicLine, issueLine } from '../tracker/format.js';
import { TrackerStore } from '../tracker/store.js';
import { isClosedStatus } from '../tracker/model.js';
import { filterModels as filterCatalog, fmtContext, fmtMoney } from '../providers/catalog.js';
import { runShell } from '../tools/bash.js';
import type { Runtime } from './runtime.js';
import { SessionStore } from './session.js';

export type CommandResult =
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'prompt'; text: string; display?: string }
  | { kind: 'task'; run: (signal: AbortSignal) => Promise<string>; label: string }
  | { kind: 'clear' }
  | { kind: 'exit' }
  | { kind: 'ui'; action: 'resume' | 'help' | 'diff' | 'tasks' | 'model' | 'copy' | 'bare' | 'context' | 'mouse'; arg?: string };

export interface SlashCommandInfo {
  name: string;
  description: string;
  hint?: string;
  origin: string;
}

const BUILTIN: SlashCommandInfo[] = [
  { name: 'help', description: 'Show commands and shortcuts', origin: 'builtin' },
  { name: 'plan', description: 'Enter plan mode (read-only) and plan the given task', hint: '[task]', origin: 'builtin' },
  { name: 'create-tasks', description: 'Decompose a plan into phased tracker tasks', hint: '[plan text | file | empty = last plan]', origin: 'builtin' },
  { name: 'run-phase', description: 'Execute all tasks of phase N with the run-phase agent', hint: '<N | epic id | name>', origin: 'builtin' },
  { name: 'schedule', description: 'Deferred work: list, add a reminder, or cancel one', hint: '[<delay> <text> | cancel <id>]', origin: 'builtin' },
  { name: 'phases', description: 'Show phases (epics) and progress', origin: 'builtin' },
  { name: 'tasks', description: 'Show ready tasks from the tracker', hint: '[phase]', origin: 'builtin' },
  { name: 'mode', description: 'Permission mode: default | acceptEdits | plan | autonomous', hint: '[mode]', origin: 'builtin' },
  { name: 'iris', description: 'Show permission rules and shield state (alias /permissions)', origin: 'builtin' },
  { name: 'model', description: 'Pick a model: catalog with prices, providers per model', hint: '[model][@provider,provider]', origin: 'builtin' },
  { name: 'models', description: 'List the catalog of a provider with prices', hint: '[provider] [filter]', origin: 'builtin' },
  { name: 'copy', description: 'Copy the last answer to the clipboard (ctrl+y)', origin: 'builtin' },
  { name: 'bare', description: 'Toggle the console-only layout for clean mouse selection (ctrl+b)', origin: 'builtin' },
  { name: 'mouse', description: 'Toggle wheel scrolling; off restores drag-select (F7)', origin: 'builtin' },
  { name: 'reasoning', description: 'Reasoning effort: off | low | medium | high', hint: '[level]', origin: 'builtin' },
  { name: 'compact', description: 'Summarize the conversation to free context', hint: '[instructions]', origin: 'builtin' },
  { name: 'clear', description: 'Start a fresh conversation', origin: 'builtin' },
  { name: 'resume', description: 'Resume a previous session (picker, or by id prefix)', hint: '[id]', origin: 'builtin' },
  { name: 'mcp', description: 'MCP servers status; /mcp reconnect <name>', hint: '[reconnect <name>]', origin: 'builtin' },
  { name: 'skills', description: 'List available skills', origin: 'builtin' },
  { name: 'agents', description: 'List available subagents', origin: 'builtin' },
  { name: 'plugins', description: 'List loaded plugins', origin: 'builtin' },
  { name: 'status', description: 'Session, model, context and token usage', origin: 'builtin' },
  { name: 'context', description: 'What the context window is spent on', origin: 'builtin' },
  { name: 'init', description: 'Create ALTERAN.md with codebase guidance', origin: 'builtin' },
  { name: 'diff', description: 'Show working tree diff', origin: 'builtin' },
  { name: 'exit', description: 'Quit', origin: 'builtin' },
];

const ALIASES: Record<string, string> = { permissions: 'iris', quit: 'exit', cost: 'status', '?': 'help' };

export function listSlashCommands(rt: Runtime): SlashCommandInfo[] {
  const out = [...BUILTIN];
  for (const c of rt.ext.commands.values()) out.push({ name: c.name, description: c.description ?? '', hint: c.argumentHint, origin: c.origin });
  for (const s of rt.ext.skills.values()) {
    if (!out.some((o) => o.name === s.name)) out.push({ name: s.name, description: s.description.slice(0, 100), origin: `skill ${s.origin}` });
  }
  for (const srv of rt.mcp.servers.values()) {
    for (const p of srv.prompts) out.push({ name: `mcp__${srv.def.name}__${p.name}`, description: p.description ?? '', origin: 'mcp' });
  }
  return out;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Claude-style command templates: $ARGUMENTS, $1..$9, !`shell`, @file. */
async function expandCommand(rt: Runtime, cmd: CommandDef, args: string): Promise<string> {
  const argv = splitArgs(args);
  let body = cmd.body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_, n) => argv[Number(n) - 1] ?? '');
  const shellMatches = [...body.matchAll(/!`([^`]+)`/g)];
  for (const m of shellMatches) {
    const r = await runShell(rt, m[1], { timeout: 30_000, trackCwd: false });
    body = body.replace(m[0], r.output.trim());
  }
  body = body.replace(/(^|\s)@([\w./~-]+\.[\w]+)/g, (full, pre, p) => {
    const file = path.resolve(rt.cwd, p);
    try {
      return `${pre}\n<file path="${p}">\n${fs.readFileSync(file, 'utf8')}\n</file>\n`;
    } catch {
      return full;
    }
  });
  if (!cmd.body.includes('$ARGUMENTS') && !/\$\d/.test(cmd.body) && args) body += `\n\nARGUMENTS: ${args}`;
  return body;
}

function tracker(rt: Runtime): TrackerStore | undefined {
  if (!rt.tracker) {
    const found = TrackerStore.discover(rt.cwd);
    if (found) rt.attachTracker(found);
  }
  return rt.tracker;
}

export async function runSlashCommand(rt: Runtime, input: string): Promise<CommandResult> {
  const m = input.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return { kind: 'error', text: 'Not a command' };
  const name = ALIASES[m[1]] ?? m[1];
  const args = m[2].trim();

  switch (name) {
    case 'help':
      return { kind: 'ui', action: 'help' };
    case 'exit':
      return { kind: 'exit' };
    case 'clear':
      rt.clearConversation();
      return { kind: 'clear' };
    case 'resume':
      return { kind: 'ui', action: 'resume', arg: args || undefined };
    case 'diff':
      return { kind: 'ui', action: 'diff' };
    case 'context':
      return { kind: 'ui', action: 'context' };
    case 'copy':
      return { kind: 'ui', action: 'copy' };
    case 'bare':
      return { kind: 'ui', action: 'bare' };
    case 'mouse':
      return { kind: 'ui', action: 'mouse' };

    case 'plan':
      rt.setMode('plan');
      return args
        ? { kind: 'prompt', text: `${args}\n\nInvestigate and produce an implementation plan organized by phases, then call ExitPlanMode.` , display: `/plan ${args}` }
        : { kind: 'info', text: 'Plan mode ON: read-only investigation. Describe the task; the plan will be offered for approval.' };

    case 'mode': {
      if (!args) return { kind: 'info', text: `Mode: ${rt.mode}. Available: default, acceptEdits, plan, autonomous` };
      const parsed = PermissionModeSchema.safeParse(args === 'auto' ? 'autonomous' : args);
      if (!parsed.success) return { kind: 'error', text: `Unknown mode "${args}"` };
      rt.setMode(parsed.data as PermissionMode);
      return { kind: 'info', text: `Mode: ${parsed.data}` };
    }

    case 'model': {
      if (!args) return { kind: 'ui', action: 'model' };
      // "provider:model@upstream" pins the gateway route along with the model.
      const at = args.lastIndexOf('@');
      const spec = at > 0 ? args.slice(0, at) : args;
      const upstream = at > 0 ? args.slice(at + 1) : '';
      try {
        rt.setModel(spec);
        updateUserSettings({ model: rt.model.id });
        // "@a,b" pins a priority list; "@auto" clears it.
        if (at > 0) rt.setRoute(upstream === 'auto' ? [] : upstream.split(',').map((u) => u.trim()).filter(Boolean));
        const route = rt.registry.route(rt.model);
        return { kind: 'info', text: `Model set to ${rt.model.id}${route ? ` via ${route.join(', ')}` : ''} (saved as default)` };
      } catch (e) {
        return { kind: 'error', text: (e as Error).message };
      }
    }

    case 'models': {
      const [maybeProvider, ...rest] = args.split(/\s+/).filter(Boolean);
      const provider = maybeProvider && rt.registry.configs[maybeProvider] ? maybeProvider : rt.model.provider;
      const filter = (maybeProvider && rt.registry.configs[maybeProvider] ? rest : [maybeProvider, ...rest]).filter(Boolean).join(' ');
      return {
        kind: 'task',
        label: `Loading the ${provider} catalog`,
        run: async () => {
          const all = await rt.catalog.models(provider);
          const models = filterCatalog(all, filter);
          if (!models.length) return `No model in ${provider} matches "${filter}"`;
          const rows = models.slice(0, 40).map((m) => {
            const price = m.pricing ? `${fmtMoney(m.pricing.in, m.pricing.currency)} / ${fmtMoney(m.pricing.out, m.pricing.currency)}` : '—';
            return `${m.id === rt.model.model ? '*' : ' '} ${m.id.padEnd(44)} ${fmtContext(m.contextWindow).padStart(5)}  ${price}`;
          });
          const more = models.length > 40 ? `\n… ${models.length - 40} more (narrow the filter)` : '';
          return [`${provider}: ${models.length} models (price per 1M in / out)`, ...rows].join('\n') + more;
        },
      };
    }

    case 'reasoning': {
      if (!['off', 'low', 'medium', 'high'].includes(args)) return { kind: 'info', text: `Reasoning: ${rt.reasoning} (off | low | medium | high)` };
      const before = rt.reasoning;
      rt.reasoning = args as typeof rt.reasoning;
      // The effort setting is part of the prompt, so changing it mid-conversation drops the
      // cached history — worth saying out loud rather than discovering it on the bill.
      const note = before !== rt.reasoning && rt.main.messages.length ? ' — the conversation will be re-read once at full price' : '';
      return { kind: 'info', text: `Reasoning: ${rt.reasoning}${note}` };
    }

    case 'compact':
      return {
        kind: 'task',
        label: 'Compacting conversation',
        run: async (signal) => {
          const before = rt.main.contextTokens;
          await rt.main.compact(signal, args || undefined);
          return `Compacted: ~${Math.round(before / 1000)}k → ~${Math.round(rt.main.contextTokens / 1000)}k tokens`;
        },
      };

    case 'status': {
      const u = rt.main.usage;
      const info = rt.registry.info(rt.model);
      const route = rt.registry.route(rt.model);
      return {
        kind: 'info',
        text: [
          `Session: ${rt.session.id}`,
          `Model: ${rt.model.id} (context ${Math.round(info.contextWindow / 1000)}k)${route ? ` via ${route.join(', ')}` : ''}   Reasoning: ${rt.reasoning}   Mode: ${rt.mode}`,
          `Context: ${Math.round(rt.main.contextTokens / 1000)}k tokens (${Math.round((rt.main.contextTokens / info.contextWindow) * 100)}%)`,
          `Tokens: in ${u.inputTokens}  cache-read ${u.cacheReadTokens}  cache-write ${u.cacheWriteTokens}  out ${u.outputTokens}`,
          u.cost ? `Session cost: ${fmtMoney(u.cost, u.currency)}` : '',
          `Tracker: ${rt.tracker ? rt.tracker.jsonlPath : 'not initialized'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    case 'iris': {
      const r = rt.permissions.rules;
      return {
        kind: 'info',
        text: [
          `Mode: ${rt.mode}`,
          ...rt.permissions.shield().map((s) => `${s.label.padEnd(8)} [${s.state === 'on' ? '#' : s.state === 'partial' ? '/' : ' '}] ${s.text}`),
          `Allow rules: ${r.allow.length}  Deny: ${r.deny.length}  Ask: ${r.ask.length}`,
          r.deny.length ? `Deny: ${r.deny.join(', ')}` : '',
          rt.permissions.sessionAllow.length ? `Allowed this session: ${rt.permissions.sessionAllow.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    case 'mcp': {
      if (args.startsWith('reconnect')) {
        const nameArg = args.split(/\s+/)[1];
        if (!nameArg) return { kind: 'error', text: 'Usage: /mcp reconnect <server>' };
        return { kind: 'task', label: `Reconnecting ${nameArg}`, run: async () => (await rt.mcp.reconnect(nameArg), `${nameArg}: ${rt.mcp.servers.get(nameArg)?.status}`) };
      }
      const rows = [...rt.mcp.servers.values()].map(
        (s) => `${s.status === 'connected' ? '[#]' : s.status === 'pending' ? '[/]' : '[ ]'} ${s.def.name.padEnd(28)} ${s.status.padEnd(10)} ${s.tools.length} tools  (${s.def.origin})${s.error ? `  ${s.error}` : ''}`,
      );
      return { kind: 'info', text: rows.length ? rows.join('\n') : 'No MCP servers configured' };
    }

    case 'skills':
      return { kind: 'info', text: [...rt.ext.skills.values()].map((s) => `${s.name}  (${s.origin})\n    ${s.description.slice(0, 150)}`).join('\n') || 'No skills' };
    case 'agents':
      return {
        kind: 'info',
        text: [...rt.ext.agents.values()].map((a) => `${a.name}  (${a.origin}${a.model ? `, model ${a.model}` : ''})\n    ${a.description.replace(/\s+/g, ' ').slice(0, 150)}`).join('\n'),
      };
    case 'schedule': {
      const items = rt.schedule.list();
      const show = () =>
        items.length
          ? items
              .map((i) => {
                const due = i.state === 'waiting' ? `in ${Math.max(0, Math.round((i.dueAt - Date.now()) / 1000))}s` : i.state;
                return `${i.id}  ${i.kind.padEnd(7)}  ${due.padEnd(10)}${i.everyMs ? `every ${Math.round(i.everyMs / 1000)}s  ` : ''}${i.label}`;
              })
              .join('\n')
          : 'Nothing is scheduled.';
      if (!args) return { kind: 'info', text: show() };
      const [first, ...rest] = args.split(/\s+/);
      if (first === 'cancel' || first === 'rm') {
        if (!rest.length) return { kind: 'error', text: 'Usage: /schedule cancel <id>' };
        try {
          const item = rt.schedule.cancel(rest[0]);
          return { kind: 'info', text: `Cancelled ${item.id} (${item.label}).` };
        } catch (e) {
          return { kind: 'error', text: (e as Error).message };
        }
      }
      // `/schedule 10m check the build` sets a reminder that comes back as a turn of its own.
      const text = rest.join(' ');
      if (!text) return { kind: 'error', text: 'Usage: /schedule <delay> <what to do then>, or /schedule cancel <id>' };
      try {
        const item = rt.schedule.create({ kind: 'prompt', in: first, message: text, label: text });
        return { kind: 'info', text: `Scheduled ${item.id} for ${new Date(item.dueAt).toLocaleTimeString()}: ${item.label}` };
      } catch (e) {
        return { kind: 'error', text: (e as Error).message };
      }
    }

    case 'plugins':
      return { kind: 'info', text: rt.ext.plugins.map((p) => `${p.key}  ${p.version ?? ''}  (${p.origin})  ${p.root}`).join('\n') || 'No plugins loaded' };

    case 'phases':
    case 'tasks': {
      const store = tracker(rt);
      if (!store) return { kind: 'info', text: 'No tracker in this project yet. Plan work with /plan, approve it, and tasks will be created.' };
      if (name === 'phases') return { kind: 'info', text: store.epics().map((e) => epicLine(e)).join('\n') || 'No phases yet' };
      if (args) {
        const e = store.findPhase(args);
        if (!e) return { kind: 'error', text: `Phase "${args}" not found` };
        return { kind: 'info', text: [e.title, ...store.children(e.id).map((k) => '  ' + issueLine(k))].join('\n') };
      }
      const ready = store.ready({ limit: 30 }).filter((i) => i.issue_type !== 'epic');
      return { kind: 'info', text: ready.length ? `Ready:\n${ready.map((i) => issueLine(i)).join('\n')}` : 'No ready tasks' };
    }

    case 'create-tasks': {
      let plan = args;
      if (!plan) plan = rt.lastPlan?.text ?? '';
      else if (fs.existsSync(path.resolve(rt.cwd, plan))) plan = fs.readFileSync(path.resolve(rt.cwd, plan), 'utf8');
      if (!plan) return { kind: 'error', text: 'No plan: pass plan text or a file path, or approve a plan from /plan first.' };
      const planText = plan;
      return {
        kind: 'task',
        label: 'create-tasks: decomposing plan',
        run: async (signal) => {
          const { report } = await rt.runSubagent({
            agentType: 'create-tasks',
            description: 'Decompose plan into tracker tasks',
            prompt: `The user approved this implementation plan. Decompose it into phases (epics) and tasks in the tracker.\n\n${planText}`,
            parent: rt.main,
            signal,
          });
          rt.main.pendingContext.push(`The create-tasks agent decomposed the approved plan into tracker tasks. Its report:\n${report}`);
          return report;
        },
      };
    }

    case 'run-phase': {
      if (!args) return { kind: 'error', text: 'Usage: /run-phase <N | epic id | phase name>' };
      const store = tracker(rt);
      if (!store) return { kind: 'error', text: 'No tracker in this project. Create tasks first (/plan → approve, or /create-tasks).' };
      const epic = store.findPhase(args);
      if (!epic) return { kind: 'error', text: `Phase "${args}" not found. Phases:\n${store.epics().map((e) => epicLine(e)).join('\n')}` };
      const n = TrackerStore.phaseNumber(epic);
      if (n !== undefined) {
        const earlier = store.epics().filter((e) => {
          const k = TrackerStore.phaseNumber(e.epic);
          return k !== undefined && k < n;
        });
        const open = earlier.flatMap((e) => store.children(e.epic.id).filter((c) => !isClosedStatus(c.status)));
        if (open.length) {
          return { kind: 'error', text: `Cannot start Phase ${n}: earlier phases have open tasks:\n${open.map((i) => issueLine(i)).join('\n')}` };
        }
      }
      if (isClosedStatus(epic.status)) return { kind: 'info', text: `${epic.title} is already closed.` };
      return {
        kind: 'task',
        label: `run-phase: ${epic.title}`,
        run: async (signal) => {
          const { report } = await rt.runSubagent({
            agentType: 'run-phase',
            description: epic.title,
            prompt: `Execute ${epic.title} (epic id ${epic.id}${n !== undefined ? `, phase number ${n}` : ''}). Complete every task of this phase in dependency order, verify, close each task, then report.`,
            parent: rt.main,
            signal,
          });
          rt.main.pendingContext.push(`The run-phase agent finished "${epic.title}". Its report:\n${report}`);
          return report;
        },
      };
    }

    case 'init': {
      const target = path.join(rt.root, 'ALTERAN.md');
      return {
        kind: 'prompt',
        display: '/init',
        text: `Analyze this codebase and create ${fs.existsSync(target) ? 'an improved version of' : ''} ${target} for future agent sessions: build/test/lint commands (including single-test runs), high-level architecture that needs several files to understand, and project-specific conventions. Incorporate important parts of existing README, CLAUDE.md, AGENTS.md, .cursorrules if present. Do not list obvious practices or every file. Start the file with "# ALTERAN.md".`,
      };
    }
  }

  // Custom commands (Claude/Codex/alteran/plugins).
  const cmd = rt.ext.commands.get(name) ?? [...rt.ext.commands.values()].find((c) => c.name.endsWith(`:${name}`));
  if (cmd) return { kind: 'prompt', text: `<command-name>/${cmd.name}</command-name>\n${await expandCommand(rt, cmd, args)}`, display: input.trim() };

  // Skills invoked directly.
  const skill = rt.ext.skills.get(name) ?? [...rt.ext.skills.values()].find((s) => s.name.endsWith(`:${name}`));
  if (skill) {
    const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
    return {
      kind: 'prompt',
      display: input.trim(),
      text: `<command-name>/${skill.name}</command-name>\nBase directory for this skill: ${skill.dir}\n\n${body.trim()}${args ? `\n\nARGUMENTS: ${args}` : ''}`,
    };
  }

  // MCP prompts: /mcp__server__prompt args
  const mp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mp) {
    const srv = rt.mcp.servers.get(mp[1]);
    const p = srv?.prompts.find((x) => x.name === mp[2]);
    if (srv && p) {
      const argv = splitArgs(args);
      const params: Record<string, string> = {};
      (p.arguments ?? []).forEach((a, i) => {
        if (argv[i] !== undefined) params[a.name] = argv[i];
      });
      try {
        return { kind: 'prompt', text: await rt.mcp.getPrompt(mp[1], mp[2], params), display: input.trim() };
      } catch (e) {
        return { kind: 'error', text: (e as Error).message };
      }
    }
  }

  return { kind: 'error', text: `Unknown command /${m[1]}. Type /help for the list.` };
}

export function resumeList(rt: Runtime) {
  return SessionStore.list(rt.root);
}
