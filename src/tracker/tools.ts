import { z } from 'zod';
import { ok, fail, type Tool, type ToolContext, type ToolOutput } from '../tools/types.js';
import { projectRoot } from '../config/paths.js';
import { epicLine, issueDetails, issueLine } from './format.js';
import { ISSUE_TYPES, DEP_TYPES } from './model.js';
import { TrackerStore } from './store.js';

function store(ctx: ToolContext, create = false): TrackerStore {
  const rt = ctx.runtime;
  if (!rt.tracker) {
    const found = TrackerStore.discover(rt.cwd);
    if (found) rt.attachTracker(found);
    else if (create) rt.attachTracker(TrackerStore.init(projectRoot(rt.cwd)));
    else throw new Error('No task tracker in this project yet. Create an issue (tasks_create) to initialize .beads/.');
  }
  return rt.tracker!;
}

function guard(fn: (ctx: ToolContext) => ToolOutput) {
  return async (ctx: ToolContext): Promise<ToolOutput> => {
    try {
      const out = fn(ctx);
      ctx.runtime.bus.emit({ type: 'tracker_changed' });
      return out;
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

const prioritySchema = z.union([z.number().int().min(0).max(4), z.string()]).describe('0-4 (P0 critical … P4 backlog)');

const createSchema = z.object({
  title: z.string().describe('Action-oriented title'),
  type: z.enum(ISSUE_TYPES).optional().describe('Default: task. Use epic for phases.'),
  priority: prioritySchema.optional(),
  description: z.string().optional().describe('What to do: files, functions, approach, estimate'),
  acceptance_criteria: z.string().optional().describe('Verifiable conditions that define done'),
  design: z.string().optional().describe('Design notes / implementation hints'),
  notes: z.string().optional(),
  parent: z.string().optional().describe('Parent epic id (creates parent-child link; child id becomes <epic>.N)'),
  deps: z.array(z.string()).optional().describe('Blocking dependencies: ids, or "type:id"'),
  labels: z.array(z.string()).optional(),
  estimated_minutes: z.number().int().optional(),
});

const createMany = z.object({ issues: z.array(createSchema).min(1).max(50) });

export const trackerTools: Tool<any>[] = [
  {
    name: 'tasks_create',
    category: 'tasks',
    description: `Create one or more issues in the project task tracker (CONSILIUM, .beads/issues.jsonl, compatible with br).
Pass {"issues":[...]} to create several at once (processed in order). Returns the new ids.
Phases are epics titled "Phase N: <name>"; tasks of a phase use parent=<epic id>.`,
    schema: createMany,
    summarize: (i: z.infer<typeof createMany>) => (i.issues.length === 1 ? i.issues[0].title : `${i.issues.length} issues`),
    run: (input: z.infer<typeof createMany>, ctx) =>
      guard((c) => {
        const s = store(c, true);
        const created = [];
        const failures: string[] = [];
        for (const spec of input.issues) {
          try {
            // `parent` may be an id, a phase number or an epic title.
            const parent = spec.parent ? (s.tryGet(spec.parent)?.id ?? s.findPhase(spec.parent)?.id ?? spec.parent) : undefined;
            created.push(s.create({ ...spec, parent, type: spec.type, priority: spec.priority }));
          } catch (e) {
            failures.push(`Failed "${spec.title}": ${(e as Error).message}`);
          }
        }
        const text = [...created.map((i) => `Created ${i.id}: ${i.title}`), ...failures].join('\n');
        return {
          content: text || 'Nothing created',
          isError: created.length === 0 && failures.length > 0,
          display: {
            summary: `Created ${created.length}${failures.length ? `, ${failures.length} failed` : ''}`,
            lines: created.map((i) => issueLine(i)),
          },
        };
      })(ctx),
  },
  {
    name: 'tasks_list',
    category: 'tasks',
    readOnly: true,
    description: 'List tracker issues. Default: open issues. Filter by status, type, parent epic, or search text.',
    schema: z.object({
      status: z.array(z.string()).optional().describe('e.g. ["open","in_progress"]; omit for all non-closed'),
      type: z.array(z.string()).optional(),
      parent: z.string().optional().describe('Epic id or phase number'),
      query: z.string().optional(),
      all: z.boolean().optional().describe('Include closed issues'),
      limit: z.number().int().optional(),
    }),
    summarize: (i: { parent?: string; query?: string }) => i.parent ?? i.query ?? '',
    run: (input: { status?: string[]; type?: string[]; parent?: string; query?: string; all?: boolean; limit?: number }, ctx) =>
      guard((c) => {
        const s = store(c);
        const parent = input.parent ? (s.findPhase(input.parent)?.id ?? input.parent) : undefined;
        const list = s.list({ ...input, parent, limit: input.limit ?? 100 });
        return ok(list.length ? list.map((i) => issueLine(i)).join('\n') : 'No issues', { summary: `${list.length} issues` });
      })(ctx),
  },
  {
    name: 'tasks_ready',
    category: 'tasks',
    readOnly: true,
    description: 'List ready work: open issues with no open blockers, in recommended order. Optionally restrict to one epic/phase.',
    schema: z.object({
      parent: z.string().optional().describe('Epic id or phase number'),
      include_epics: z.boolean().optional(),
      limit: z.number().int().optional(),
    }),
    summarize: (i: { parent?: string }) => i.parent ?? '',
    run: (input: { parent?: string; include_epics?: boolean; limit?: number }, ctx) =>
      guard((c) => {
        const s = store(c);
        const parent = input.parent ? (s.findPhase(input.parent)?.id ?? input.parent) : undefined;
        let list = s.ready({ parent, limit: input.limit });
        if (!input.include_epics) list = list.filter((i) => i.issue_type !== 'epic');
        return ok(list.length ? list.map((i) => issueLine(i)).join('\n') : 'No ready issues', { summary: `${list.length} ready` });
      })(ctx),
  },
  {
    name: 'tasks_show',
    category: 'tasks',
    readOnly: true,
    description: 'Show full details of issues: description, acceptance criteria, design notes, dependencies, dependents, comments.',
    schema: z.object({ ids: z.array(z.string()).min(1) }),
    summarize: (i: { ids: string[] }) => i.ids.join(', '),
    run: (input: { ids: string[] }, ctx) =>
      guard((c) => {
        const s = store(c);
        return ok(input.ids.map((id) => issueDetails(s, s.get(id))).join('\n\n---\n\n'), { summary: `${input.ids.length} shown` });
      })(ctx),
  },
  {
    name: 'tasks_update',
    category: 'tasks',
    description: 'Update an issue: status (open|in_progress|blocked|deferred), fields, labels. Use status in_progress when you start a task.',
    schema: z.object({
      id: z.string(),
      status: z.enum(['open', 'in_progress', 'blocked', 'deferred']).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      acceptance_criteria: z.string().optional(),
      design: z.string().optional(),
      append_notes: z.string().optional().describe('Append to notes (assumptions, blockers, progress)'),
      priority: prioritySchema.optional(),
      assignee: z.string().optional(),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
    }),
    summarize: (i: { id: string; status?: string }) => `${i.id}${i.status ? ` → ${i.status}` : ''}`,
    run: (input: { id: string } & Record<string, never>, ctx) =>
      guard((c) => {
        const { id, ...patch } = input;
        const i = store(c).update(id, patch);
        return ok(`Updated ${i.id} (${i.status})`, { summary: `${i.id} → ${i.status}` });
      })(ctx),
  },
  {
    name: 'tasks_close',
    category: 'tasks',
    description: 'Close issues once all acceptance criteria are met. Always give a short reason summarizing what was done.',
    schema: z.object({
      ids: z.array(z.string()).min(1),
      reason: z.string().describe('What was done'),
      force: z.boolean().optional().describe('Close an epic even if children are open'),
    }),
    summarize: (i: { ids: string[] }) => i.ids.join(', '),
    run: (input: { ids: string[]; reason: string; force?: boolean }, ctx) =>
      guard((c) => {
        const s = store(c);
        const closed = input.ids.map((id) => s.close(id, input.reason, { force: input.force }));
        const epics = s.epics().filter((e) => e.eligibleForClose).map((e) => e.epic.id);
        const hint = epics.length ? `\nEpics with all children closed (close them when the phase is verified): ${epics.join(', ')}` : '';
        return ok(closed.map((i) => `Closed ${i.id}: ${i.title}`).join('\n') + hint, { summary: `Closed ${closed.map((i) => i.id).join(', ')}` });
      })(ctx),
  },
  {
    name: 'tasks_dep_add',
    category: 'tasks',
    description: 'Add dependencies: each {issue, depends_on, type?}. type defaults to "blocks" (issue cannot start until depends_on is closed). Cycles are rejected.',
    schema: z.object({
      deps: z
        .array(z.object({ issue: z.string(), depends_on: z.string(), type: z.enum(DEP_TYPES).optional() }))
        .min(1),
    }),
    summarize: (i: { deps: unknown[] }) => `${i.deps.length} edge(s)`,
    run: (input: { deps: Array<{ issue: string; depends_on: string; type?: string }> }, ctx) =>
      guard((c) => {
        const s = store(c);
        const lines = input.deps.map((d) => {
          const dep = s.addDep(d.issue, d.depends_on, d.type ?? 'blocks');
          return `${dep.issue_id} --${dep.type}--> ${dep.depends_on_id}`;
        });
        return ok(lines.join('\n'), { summary: `Added ${lines.length} dependency edge(s)` });
      })(ctx),
  },
  {
    name: 'tasks_comment',
    category: 'tasks',
    description: 'Add a comment to an issue (progress notes, blockers, decisions).',
    schema: z.object({ id: z.string(), text: z.string() }),
    summarize: (i: { id: string }) => i.id,
    run: (input: { id: string; text: string }, ctx) =>
      guard((c) => {
        const cm = store(c).addComment(input.id, input.text);
        return ok(`Comment #${cm.id} added to ${cm.issue_id}`, { summary: `Commented on ${cm.issue_id}` });
      })(ctx),
  },
  {
    name: 'tasks_phases',
    category: 'tasks',
    readOnly: true,
    description: 'Show all phases (epics) with progress, or one phase with its tasks when `phase` (number, id or name) is given.',
    schema: z.object({ phase: z.string().optional() }),
    summarize: (i: { phase?: string }) => i.phase ?? '',
    run: (input: { phase?: string }, ctx) =>
      guard((c) => {
        const s = store(c);
        if (!input.phase) {
          const epics = s.epics();
          return ok(epics.length ? epics.map((e) => epicLine(e)).join('\n') : 'No phases (epics) yet', { summary: `${epics.length} phases` });
        }
        const e = s.findPhase(input.phase);
        if (!e) return fail(`Phase "${input.phase}" not found`);
        const kids = s.children(e.id);
        const info = s.blockInfo();
        return ok(
          [issueDetails(s, e), '', 'Tasks:', ...kids.map((k) => `  ${issueLine(k)}${info.get(k.id)?.blocked ? `  (blocked by ${info.get(k.id)!.blockers.join(', ')})` : ''}`)].join('\n'),
          { summary: `${e.id}: ${kids.length} tasks` },
        );
      })(ctx),
  },
];
