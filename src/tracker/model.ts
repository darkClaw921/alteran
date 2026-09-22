/**
 * Issue model compatible with beads_rust (`br`) `.beads/issues.jsonl` records.
 * Unknown fields are preserved verbatim so round-trips never lose data.
 */

export const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'draft', 'closed', 'tombstone', 'pinned'] as const;
export const ISSUE_TYPES = ['task', 'bug', 'feature', 'epic', 'chore', 'docs', 'question'] as const;
export const DEP_TYPES = [
  'blocks',
  'parent-child',
  'conditional-blocks',
  'waits-for',
  'related',
  'discovered-from',
  'replies-to',
  'relates-to',
  'duplicates',
  'supersedes',
  'caused-by',
] as const;

/** Dependency types that gate readiness (beads `affects_ready_work`). */
export const BLOCKING_DEP_TYPES = new Set(['blocks', 'conditional-blocks', 'waits-for']);

export type Status = (typeof STATUSES)[number] | (string & {});
export type IssueType = (typeof ISSUE_TYPES)[number] | (string & {});
export type DepType = (typeof DEP_TYPES)[number] | (string & {});

export interface Dependency {
  issue_id: string;
  depends_on_id: string;
  type: DepType;
  created_at: string;
  created_by?: string;
  metadata?: string;
  thread_id?: string;
}

export interface Comment {
  id: number;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

export interface Issue {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status: Status;
  priority: number;
  issue_type: IssueType;
  assignee?: string;
  owner?: string;
  estimated_minutes?: number;
  created_at: string;
  created_by?: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  due_at?: string;
  defer_until?: string;
  external_ref?: string;
  source_repo?: string;
  deleted_at?: string;
  deleted_by?: string;
  delete_reason?: string;
  compaction_level?: number;
  original_size?: number;
  labels?: string[];
  dependencies?: Dependency[];
  comments?: Comment[];
  [extra: string]: unknown;
}

/** Field order used by br when exporting, so diffs of issues.jsonl stay minimal. */
export const FIELD_ORDER = [
  'id',
  'content_hash',
  'title',
  'description',
  'design',
  'acceptance_criteria',
  'notes',
  'status',
  'priority',
  'issue_type',
  'assignee',
  'owner',
  'estimated_minutes',
  'created_at',
  'created_by',
  'updated_at',
  'closed_at',
  'close_reason',
  'closed_by_session',
  'due_at',
  'defer_until',
  'external_ref',
  'source_system',
  'source_repo',
  'deleted_at',
  'deleted_by',
  'delete_reason',
  'original_type',
  'compaction_level',
  'compacted_at',
  'compacted_at_commit',
  'original_size',
  'sender',
  'ephemeral',
  'pinned',
  'is_template',
  'labels',
  'dependencies',
  'comments',
];

export function serializeIssue(issue: Issue): string {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) {
    const v = issue[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(issue)) {
    if (!(k in out) && !FIELD_ORDER.includes(k) && v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

export function isClosedStatus(s: Status) {
  return s === 'closed' || s === 'tombstone';
}

export function normalizePriority(p: string | number | undefined, fallback = 2): number {
  if (p === undefined || p === '') return fallback;
  const s = String(p).trim().toUpperCase().replace(/^P/, '');
  const words: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, BACKLOG: 4 };
  const n = words[s] ?? Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 4) throw new Error(`Invalid priority "${p}" (expected 0-4 or P0-P4)`);
  return n;
}
