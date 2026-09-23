import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail, ok, type Tool } from './types.js';
import { truncateMiddle } from './bash.js';

const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1),
        status: z.enum(['pending', 'in_progress', 'completed']),
        activeForm: z.string().optional(),
      }),
    )
    .describe('The full updated todo list'),
});

export const TodoWriteTool: Tool<z.infer<typeof todoSchema>> = {
  name: 'TodoWrite',
  category: 'meta',
  readOnly: true,
  description: `Maintains a short session checklist for the current request (shown in the CONSILIUM panel).
Use it for multi-step work: send the whole list each time, keep exactly one item in_progress, mark items completed immediately.
For persistent, multi-phase project work use the tasks_* tracker tools instead.`,
  schema: todoSchema,
  summarize: () => '',
  async run(input, ctx) {
    ctx.agent.todos = input.todos;
    ctx.runtime.bus.emit({ type: 'todos', agentId: ctx.agent.id, todos: input.todos });
    const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;
    return ok('Todos updated. Continue with the in-progress item.', {
      summary: `${input.todos.filter((t) => t.status === 'completed').length}/${input.todos.length} done`,
      lines: input.todos.map((t) => `${mark[t.status]} ${t.content}`),
    });
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h(\d)[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const WebFetchTool: Tool<{ url: string; prompt?: string }> = {
  name: 'WebFetch',
  category: 'network',
  description: `Fetches a URL, converts HTML to text and (if prompt is given) answers the prompt about the page with a fast model.
HTTP is upgraded to HTTPS. Use for docs and public pages; not for authenticated URLs.`,
  schema: z.object({
    url: z.string().url().describe('URL to fetch'),
    prompt: z.string().optional().describe('What to extract from the page'),
  }),
  summarize: (i) => i.url,
  async run(input, ctx) {
    const url = input.url.replace(/^http:\/\//, 'https://');
    let res: Response;
    try {
      res = await fetch(url, { signal: ctx.signal, redirect: 'follow', headers: { 'User-Agent': 'alteran/0.1' } });
    } catch (e) {
      return fail(`Fetch failed: ${(e as Error).message}`);
    }
    if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const text = type.includes('html') ? htmlToText(raw) : raw;
    const body = truncateMiddle(text, 60_000);
    if (!input.prompt) return ok(body, { summary: `Fetched ${Math.round(raw.length / 1024)}KB (${res.status})` });
    try {
      const answer = await ctx.runtime.oneShot(
        `Answer the request using only the page content below.\n\nRequest: ${input.prompt}\n\n<page url="${url}">\n${body}\n</page>`,
        ctx.signal,
      );
      return ok(answer, { summary: `Fetched ${Math.round(raw.length / 1024)}KB, answered` });
    } catch {
      return ok(body, { summary: `Fetched ${Math.round(raw.length / 1024)}KB` });
    }
  },
};

const askSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(4),
});
export type AskQuestions = z.infer<typeof askSchema>['questions'];

export const AskUserQuestionTool: Tool<z.infer<typeof askSchema>> = {
  name: 'AskUserQuestion',
  category: 'meta',
  readOnly: true,
  description:
    'Ask the user 1-4 multiple-choice questions when blocked on a decision that is genuinely theirs. The user can always answer "Other" with free text.',
  schema: askSchema,
  summarize: (i) => i.questions.map((q) => q.header ?? q.question).join(', '),
  async run(input, ctx) {
    if (!ctx.runtime.ui?.askQuestions) return fail('No interactive user available; proceed with sensible defaults and state assumptions.');
    const answers = await ctx.runtime.ui.askQuestions(input.questions, ctx.signal);
    const text = input.questions.map((q) => `"${q.question}" = "${answers[q.question] ?? '(no answer)'}"`).join('\n');
    return ok(`User answered:\n${text}`, { summary: 'User answered', lines: text.split('\n') });
  },
};

export const ExitPlanModeTool: Tool<{ plan: string }> = {
  name: 'ExitPlanMode',
  category: 'meta',
  readOnly: true,
  description: `Call when you are in plan mode and the implementation plan is complete. The plan (markdown) is shown to the user,
who can approve it (optionally decomposing it into phased tracker tasks) or send feedback to keep planning.`,
  schema: z.object({ plan: z.string().describe('The full implementation plan in markdown, organized by phases') }),
  summarize: () => '',
  async run(input, ctx) {
    const rt = ctx.runtime;
    const file = path.join(rt.root, '.alteran', 'plans', `plan-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input.plan);
    rt.lastPlan = { text: input.plan, file };
    rt.bus.emit({ type: 'plan_ready', plan: input.plan });
    if (!rt.ui?.reviewPlan) {
      rt.setMode(rt.modeBeforePlan ?? 'default');
      return ok(`Plan saved to ${file}. Proceed with implementation.`, { summary: 'Plan saved' });
    }
    const decision = await rt.ui.reviewPlan(input.plan, ctx.signal);
    if (decision.kind === 'feedback') {
      return ok(`User did not approve the plan yet. Feedback:\n${decision.text}\n\nRevise the plan and call ExitPlanMode again.`, {
        summary: 'Changes requested',
      });
    }
    rt.setMode(decision.mode ?? rt.modeBeforePlan ?? 'default');
    if (decision.kind === 'tasks') {
      const { report } = await rt.runSubagent({
        agentType: 'create-tasks',
        description: 'Decompose plan into tracker tasks',
        prompt: `The user approved this implementation plan (saved at ${file}). Decompose it into phases (epics) and tasks in the tracker.\n\n${input.plan}`,
        parent: ctx.agent,
        signal: ctx.signal,
      });
      return ok(
        `User approved the plan and it was decomposed into tracker tasks by the create-tasks agent.\n\n${report}\n\nDo not start implementing now. Summarize the created phases for the user and tell them to run /run-phase 1 to start execution.`,
        { summary: 'Plan approved, tasks created' },
      );
    }
    return ok(`User approved the plan (saved to ${file}). Start implementing it now.`, { summary: 'Plan approved' });
  },
};
