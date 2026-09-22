import fs from 'node:fs';
import { z } from 'zod';
import { parseFrontmatter } from '../compat/frontmatter.js';
import { fail, ok, type Tool } from './types.js';
import { toolJsonSchema } from './schema.js';

const taskSchema = z.object({
  description: z.string().describe('Short (3-5 word) description of the task'),
  prompt: z.string().describe('Complete, self-contained task for the agent'),
  subagent_type: z.string().optional().describe('Agent type to use (default: general-purpose)'),
});

export const TaskTool: Tool<z.infer<typeof taskSchema>> = {
  name: 'Task',
  category: 'meta',
  readOnly: true,
  get description() {
    return 'Launch a subagent with its own context to handle a complex, multi-step task autonomously. Available agent types are listed in the system prompt. Launch independent agents in parallel with multiple Task calls in one message. The agent returns a single final report; relay what matters to the user.';
  },
  schema: taskSchema,
  summarize: (i) => `${i.subagent_type ?? 'general-purpose'}: ${i.description}`,
  async run(input, ctx) {
    try {
      const report = await ctx.runtime.runSubagent({
        agentType: input.subagent_type ?? 'general-purpose',
        description: input.description,
        prompt: input.prompt,
        parent: ctx.agent,
        signal: ctx.signal,
      });
      return ok(report || '(agent returned no output)', { summary: 'Done', lines: report.split('\n').slice(0, 20) });
    } catch (e) {
      return fail(`Agent failed: ${(e as Error).message}`);
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
