import fs from 'node:fs';
import { z } from 'zod';
import { parseFrontmatter } from '../compat/frontmatter.js';
import { fail, ok, type Tool } from './types.js';
import { toolJsonSchema } from './schema.js';

const taskSchema = z.object({
  description: z.string().describe('Short (3-5 word) description of the task'),
  prompt: z.string().describe('Complete, self-contained task for the agent'),
  subagent_type: z.string().optional().describe('Agent type to use (default: general-purpose)'),
  background: z
    .boolean()
    .optional()
    .describe('Run without blocking: the call returns at once and the report arrives later as a notification'),
});

export const TaskTool: Tool<z.infer<typeof taskSchema>> = {
  name: 'Task',
  category: 'meta',
  readOnly: true,
  get description() {
    return `Launch an agent with its own context to handle a task that would otherwise flood yours: broad searches, independent work that can run in parallel, or a job a listed agent type is built for. Available agent types are listed in the system prompt.
Give a complete, self-contained prompt — the agent sees none of this conversation. Its final report comes back to you, not to the user, so relay what matters.
With \`background: true\` the call returns immediately with the agent's name and its report arrives later as a notification; use it for long independent work. Otherwise the call blocks until the agent is done.
The agent stays addressable after it reports: continue it with SendMessage instead of launching a new one that starts from nothing.`;
  },
  schema: taskSchema,
  summarize: (i) => `${i.subagent_type ?? 'general-purpose'}: ${i.description}`,
  async run(input, ctx) {
    const req = {
      agentType: input.subagent_type ?? 'general-purpose',
      description: input.description,
      prompt: input.prompt,
      parent: ctx.agent,
      signal: ctx.signal,
      background: input.background,
    };
    let run;
    try {
      run = ctx.runtime.agents.spawn(req);
    } catch (e) {
      return fail(`Could not launch agent: ${(e as Error).message}`);
    }
    if (input.background) {
      // The promise is owned by the registry; nothing here may await it or the launch would block.
      void run.turn;
      return ok(
        `Launched agent "${run.name}" (${req.agentType}) in the background. Its report will arrive as a notification — do not guess at its results before then. Continue with other work, or use ListAgents to check on it.`,
        { summary: `Launched ${run.name}` },
      );
    }
    const result = await run.turn;
    if (result.state === 'stopped') return fail(`Agent ${run.name} was stopped: ${result.report || 'interrupted'}`);
    if (result.state === 'failed') return fail(`Agent ${run.name} failed: ${result.report}`);
    const report = result.report || '(agent returned no output)';
    return ok(`${report}\n\n[agent "${run.name}" is still addressable with SendMessage]`, {
      summary: `${run.name} done`,
      lines: report.split('\n').slice(0, 20),
    });
  },
};

export const ListAgentsTool: Tool<Record<string, never>> = {
  name: 'ListAgents',
  category: 'meta',
  readOnly: true,
  description:
    'List the agents launched in this session with their state, model and elapsed time. The names it prints are the addresses SendMessage and TaskStop take.',
  schema: z.object({}),
  summarize: () => '',
  async run(_input, ctx) {
    const runs = ctx.runtime.agents.list();
    if (!runs.length) return ok('No agents have been launched in this session.', { summary: 'No agents' });
    const lines = runs.map((r) => {
      const secs = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000);
      const usage = r.agent.usage;
      const tokens = usage.inputTokens + usage.outputTokens;
      return `${r.name}\t${r.state}${r.background ? ' (background)' : ''}\t${r.agent.model.id}\t${secs}s\t${tokens} tokens\t${r.description}`;
    });
    return ok(`name\tstate\tmodel\telapsed\ttokens\ttask\n${lines.join('\n')}`, { summary: `${runs.length} agents`, lines });
  },
};

const sendSchema = z.object({
  to: z.string().describe('Agent name exactly as ListAgents or Task printed it'),
  message: z.string().describe('Complete message; the agent keeps its context, so no need to repeat it'),
});

export const SendMessageTool: Tool<z.infer<typeof sendSchema>> = {
  name: 'SendMessage',
  category: 'meta',
  readOnly: true,
  description: `Continue an agent that already ran, with its context intact — follow-up questions, corrections, or more work on what it just did. Prefer this over a fresh Task, which starts from nothing.
A finished agent runs the message and its reply comes back here. A still-running agent takes the message as guidance and this call returns at once; its answer arrives with its report.`,
  schema: sendSchema,
  summarize: (i) => i.to,
  async run(input, ctx) {
    let res;
    try {
      res = await ctx.runtime.agents.deliver(input.to, input.message, ctx.signal);
    } catch (e) {
      return fail((e as Error).message);
    }
    if (res === 'queued') {
      return ok(`Agent "${input.to}" is still working; the message was delivered as guidance and will reach it on its next step. Its answer comes with its report.`, {
        summary: 'Queued',
      });
    }
    if (res.state === 'stopped') return fail(`Agent ${input.to} was stopped: ${res.report || 'interrupted'}`);
    if (res.state === 'failed') return fail(`Agent ${input.to} failed: ${res.report}`);
    return ok(res.report || '(agent returned no output)', { summary: `${input.to} replied`, lines: res.report.split('\n').slice(0, 20) });
  },
};

export const TaskStopTool: Tool<{ to: string }> = {
  name: 'TaskStop',
  category: 'meta',
  readOnly: true,
  description: 'Cancel a running agent by name. Work it already did (file edits, commands) is not undone.',
  schema: z.object({ to: z.string().describe('Agent name as ListAgents printed it') }),
  summarize: (i) => i.to,
  async run(input, ctx) {
    try {
      const run = ctx.runtime.agents.stop(input.to);
      return ok(`Stopped agent "${run.name}". Anything it already changed stays changed.`, { summary: `Stopped ${run.name}` });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

const scheduleSchema = z.object({
  kind: z
    .enum(['prompt', 'command', 'message'])
    .describe('prompt = remind yourself and pick the work up then; command = run a shell command; message = send a message to an agent'),
  in: z.string().optional().describe('Delay before the first run: 45s, 10m, 2h, 1h30m (default 5m, minimum 1s)'),
  at: z.string().optional().describe('Absolute first run as an ISO timestamp, instead of `in`'),
  every: z.string().optional().describe('Repeat this often, counted from the end of the previous run (minimum 5s)'),
  command: z.string().optional().describe('Shell command, for kind=command'),
  message: z.string().optional().describe('Text to deliver, for kind=prompt or kind=message'),
  to: z.string().optional().describe('Agent name for kind=message; omit to send it to yourself'),
  label: z.string().optional().describe('Short name for the schedule panel'),
});

export const ScheduleTool: Tool<z.infer<typeof scheduleSchema>> = {
  name: 'Schedule',
  category: 'meta',
  readOnly: true,
  description: `Set work up to happen later instead of waiting for it now: a command to run in a while, a message to send an agent then, or a reminder to pick something up yourself.
Every firing comes back to you as a notification with its result, so schedule the work and carry on — do not idle waiting for it.
A scheduled command runs through the same permission rules as a command you run yourself; if it would need approval and nobody is there to give it, the run fails instead of proceeding.
Use \`every\` for something worth re-checking (a build, a queue, a deploy) and cancel it with ScheduleCancel once the answer arrives. Pick an interval that matches how fast the thing actually changes.
What you schedule is yours: it comes back to you, and ScheduleList and ScheduleCancel only cover your own items. If you have already delivered your report when it fires, you are woken again with the same context and whatever you find then goes on to whoever launched you.`,
  schema: scheduleSchema,
  summarize: (i) => `${i.kind} ${i.in ?? i.at ?? '5m'}${i.every ? ` every ${i.every}` : ''}`,
  async run(input, ctx) {
    // A one-shot run exits as soon as the answer is printed, so nothing deferred would ever fire.
    if (!ctx.runtime.ui) return fail('Deferred work needs an interactive session; this run ends as soon as it answers. Do the work now instead.');
    try {
      const item = ctx.runtime.schedule.create({ ...input, owner: ctx.agent.id, ownerName: ctx.agent.label });
      const when = new Date(item.dueAt).toISOString().slice(11, 19);
      const repeat = item.everyMs ? `, then every ${Math.round(item.everyMs / 1000)}s until cancelled` : '';
      return ok(`Scheduled ${item.id} (${item.kind}) for ${when} UTC${repeat}. Its result will arrive as a notification; do not guess at it before then.`, {
        summary: `${item.id} at ${when}`,
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

export const ScheduleListTool: Tool<Record<string, never>> = {
  name: 'ScheduleList',
  category: 'meta',
  readOnly: true,
  description: 'List the deferred work you set up: what it is, when it next fires and how the last run went.',
  schema: z.object({}),
  summarize: () => '',
  async run(_input, ctx) {
    const items = ctx.runtime.schedule.list(ctx.agent.id);
    if (!items.length) return ok('Nothing is scheduled.', { summary: 'Nothing scheduled' });
    const lines = items.map((i) => {
      const due = i.state === 'waiting' ? `${Math.max(0, Math.round((i.dueAt - Date.now()) / 1000))}s` : '-';
      return `${i.id}\t${i.kind}\t${i.state}\t${due}\t${i.everyMs ? `every ${Math.round(i.everyMs / 1000)}s` : 'once'}\t${i.label}`;
    });
    return ok(`id\tkind\tstate\tdue in\trepeat\tlabel\n${lines.join('\n')}`, { summary: `${items.length} scheduled`, lines });
  },
};

export const ScheduleCancelTool: Tool<{ id: string }> = {
  name: 'ScheduleCancel',
  category: 'meta',
  readOnly: true,
  description: 'Cancel deferred work by id. A run already in flight finishes, but it will not repeat.',
  schema: z.object({ id: z.string().describe('Schedule id as ScheduleList printed it') }),
  summarize: (i) => i.id,
  async run(input, ctx) {
    try {
      const item = ctx.runtime.schedule.cancel(input.id, ctx.agent.id);
      return ok(`Cancelled ${item.id} (${item.label}).`, { summary: `Cancelled ${item.id}` });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

export const SkillTool: Tool<{ skill: string; args?: string }> = {
  name: 'Skill',
  category: 'meta',
  readOnly: true,
  description:
    'Load a skill (packaged instructions) by exact name from the skills list in the system prompt. Call it before starting a task the skill covers, then follow its instructions.',
  schema: z.object({
    skill: z.string().describe('Exact skill name'),
    args: z.string().optional().describe('Optional arguments'),
  }),
  summarize: (i) => i.skill,
  async run(input, ctx) {
    const skill = ctx.runtime.ext.skills.get(input.skill) ?? [...ctx.runtime.ext.skills.values()].find((s) => s.name.endsWith(`:${input.skill}`));
    if (!skill) return fail(`Unknown skill "${input.skill}". Available: ${[...ctx.runtime.ext.skills.keys()].join(', ')}`);
    const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
    const args = input.args ? `\n\nARGUMENTS: ${input.args}` : '';
    return ok(`Base directory for this skill: ${skill.dir}\n\n${body.trim()}${args}`, { summary: `Loaded skill ${skill.name}` });
  },
};

export const ToolSearchTool: Tool<{ query: string; max_results?: number }> = {
  name: 'ToolSearch',
  category: 'meta',
  readOnly: true,
  description: `Find and load deferred tools (MCP tools are deferred when there are many). Query forms:
"select:name1,name2" loads exact tools; otherwise keywords are matched against tool names and descriptions.
Loaded tools become callable from the next step.`,
  schema: z.object({ query: z.string(), max_results: z.number().int().min(1).max(30).optional() }),
  summarize: (i) => i.query,
  async run(input, ctx) {
    const deferred = ctx.runtime.allTools().filter((t) => t.deferred);
    let found: Tool<any>[];
    if (input.query.startsWith('select:')) {
      const names = input.query.slice(7).split(',').map((s) => s.trim());
      found = deferred.filter((t) => names.includes(t.name));
    } else {
      const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const required = words.filter((w) => w.startsWith('+')).map((w) => w.slice(1));
      const rest = words.filter((w) => !w.startsWith('+'));
      found = deferred
        .filter((t) => required.every((w) => t.name.toLowerCase().includes(w)))
        .map((t) => {
          const hay = `${t.name} ${t.description}`.toLowerCase();
          return { t, score: rest.reduce((s, w) => s + (t.name.toLowerCase().includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
        })
        .filter((x) => x.score > 0 || rest.length === 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.t);
    }
    found = found.slice(0, input.max_results ?? 5);
    if (!found.length) return ok('No matching deferred tools.', { summary: 'No matches' });
    for (const t of found) ctx.agent.surfaced.add(t.name);
    const defs = found.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: toolJsonSchema(t) }));
    return ok(`Loaded ${found.length} tool(s); they are now callable:\n${defs.join('\n')}`, {
      summary: `Loaded ${found.map((t) => t.name).join(', ')}`,
    });
  },
};

export const ListMcpResourcesTool: Tool<{ server?: string }> = {
  name: 'ListMcpResources',
  category: 'mcp',
  readOnly: true,
  description: 'List resources exposed by connected MCP servers (optionally for one server).',
  schema: z.object({ server: z.string().optional() }),
  summarize: (i) => i.server ?? 'all servers',
  async run(input, ctx) {
    const list = await ctx.runtime.mcp.listResources(input.server);
    if (!list.length) return ok('No resources found.', { summary: 'No resources' });
    return ok(list.map((r) => `${r.server}\t${r.uri}\t${r.name ?? ''}\t${r.mimeType ?? ''}`).join('\n'), { summary: `${list.length} resources` });
  },
};

export const ReadMcpResourceTool: Tool<{ server: string; uri: string }> = {
  name: 'ReadMcpResource',
  category: 'mcp',
  readOnly: true,
  description: 'Read a resource from an MCP server by URI.',
  schema: z.object({ server: z.string(), uri: z.string() }),
  summarize: (i) => `${i.server} ${i.uri}`,
  async run(input, ctx) {
    try {
      const text = await ctx.runtime.mcp.readResource(input.server, input.uri);
      return ok(text, { summary: `Read ${text.length} chars` });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};
