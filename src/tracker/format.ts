import { paint, type ColorName } from '../util/color.js';
import type { Issue } from './model.js';
import type { EpicStatus, TrackerStore } from './store.js';

const STATUS_MARK: Record<string, string> = {
  open: '[ ]',
  in_progress: '[/]',
  closed: '[x]',
  blocked: '[!]',
  deferred: '[-]',
  tombstone: '[~]',
};

const STATUS_COLOR: Record<string, ColorName> = {
  open: 'muted',
  in_progress: 'amber',
  closed: 'green',
  blocked: 'red',
  deferred: 'dim',
  tombstone: 'dim',
};

export const statusMark = (s: string) => STATUS_MARK[s] ?? '[?]';

/** `color: false` keeps the output plain — tool results shown to the model must not carry ANSI codes. */
export function issueLine(i: Issue, color = false): string {
  const m = statusMark(i.status);
  const p = `P${i.priority}`;
  const type = i.issue_type.padEnd(7);
  if (!color) return `${m} ${i.id}  ${p} ${type} ${i.title}`;
  const c = STATUS_COLOR[i.status] ?? 'muted';
  const prio = i.priority <= 1 ? paint.amber(p) : paint.muted(p);
  const title = i.status === 'closed' ? paint.muted(i.title) : paint.text(i.title);
  return `${paint[c](m)} ${paint.cyan(i.id)}  ${prio} ${paint.dim(type)} ${title}`;
}

export function issueDetails(store: TrackerStore, i: Issue, color = false): string {
  const t = color ? paint : plainPaint;
  const out: string[] = [];
  out.push(`${t.title(i.id)}: ${t.bold(i.title)}`);
  out.push(
    `${t.muted('Status:')} ${t[STATUS_COLOR[i.status] ?? 'muted'](i.status)}   ${t.muted('Priority:')} P${i.priority}   ${t.muted('Type:')} ${i.issue_type}` +
      (i.assignee ? `   ${t.muted('Assignee:')} ${i.assignee}` : ''),
  );
  if (i.estimated_minutes) out.push(`${t.muted('Estimate:')} ${i.estimated_minutes} min`);
  if (i.labels?.length) out.push(`${t.muted('Labels:')} ${i.labels.join(', ')}`);
  out.push(`${t.muted('Created:')} ${i.created_at}${i.created_by ? ` by ${i.created_by}` : ''}   ${t.muted('Updated:')} ${i.updated_at}`);
  if (i.closed_at) out.push(`${t.muted('Closed:')} ${i.closed_at}${i.close_reason ? ` — ${i.close_reason}` : ''}`);
  const parent = store.parentOf(i);
  if (parent) {
    const p = store.tryGet(parent);
    out.push(`${t.muted('Parent:')} ${parent}${p ? ` (${p.title})` : ''}`);
  }
  const deps = (i.dependencies ?? []).filter((d) => d.type !== 'parent-child');
  if (deps.length) {
    out.push(t.muted('Depends on:'));
    for (const d of deps) {
      const target = store.tryGet(d.depends_on_id);
      out.push(`  ${t.dim(d.type + ':')} ${target ? issueLine(target, color) : d.depends_on_id}`);
    }
  }
  const rev = store.dependents(i.id);
  if (rev.length) {
    out.push(t.muted(i.issue_type === 'epic' ? 'Children / dependents:' : 'Dependents:'));
    for (const r of rev) out.push(`  ${t.dim(r.type + ':')} ${issueLine(r.issue, color)}`);
  }
  const sectionOf = (name: string, v?: string) => {
    if (v?.trim()) out.push('', t.head(`## ${name}`), v.trim());
  };
  sectionOf('Description', i.description);
  sectionOf('Design', i.design);
  sectionOf('Acceptance Criteria', i.acceptance_criteria);
  sectionOf('Notes', i.notes);
  if (i.comments?.length) {
    out.push('', t.head('## Comments'));
    for (const c of i.comments) out.push(`- ${t.dim(`[${c.created_at}]`)} ${t.cyan(c.author)}: ${c.text}`);
  }
  return out.join('\n');
}

export function epicLine(e: EpicStatus, color = false): string {
  const bar = (e.total ? `${e.closed}/${e.total}` : '0/0').padStart(5);
  const note = e.eligibleForClose ? '  (all children closed)' : '';
  if (!color) return `${statusMark(e.epic.status)} ${e.epic.id}  ${bar}  ${e.epic.title}${note}`;
  const done = e.total > 0 && e.closed === e.total;
  const c = STATUS_COLOR[e.epic.status] ?? 'muted';
  return `${paint[c](statusMark(e.epic.status))} ${paint.cyan(e.epic.id)}  ${done ? paint.green(bar) : paint.amber(bar)}  ${paint.bold(e.epic.title)}${paint.dim(note)}`;
}

/** No-op palette with the same shape as `paint`, for plain output. */
const plainPaint = new Proxy({} as typeof paint, { get: () => (s: string) => s });
