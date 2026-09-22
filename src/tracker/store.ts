import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BLOCKING_DEP_TYPES,
  DEP_TYPES,
  ISSUE_TYPES,
  isClosedStatus,
  normalizePriority,
  serializeIssue,
  type Comment,
  type DepType,
  type Dependency,
  type Issue,
  type IssueType,
  type Status,
} from './model.js';
import { projectRoot } from '../config/paths.js';

export const BEADS_DIR = '.beads';
const JSONL = 'issues.jsonl';

export interface CreateInput {
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  type?: IssueType;
  priority?: number | string;
  assignee?: string;
  labels?: string[];
  parent?: string;
  /** "type:id" or bare "id" (blocks). */
  deps?: string[];
  estimated_minutes?: number;
  status?: Status;
  slug?: string;
  external_ref?: string;
  due_at?: string;
  defer_until?: string;
}

export interface UpdateInput {
  title?: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  status?: Status;
  priority?: number | string;
  type?: IssueType;
  assignee?: string;
  estimated_minutes?: number;
  add_labels?: string[];
  remove_labels?: string[];
  defer_until?: string | null;
  due_at?: string | null;
  append_notes?: string;
}

export interface ListFilter {
  status?: Status[];
  type?: IssueType[];
  priority?: number[];
  parent?: string;
  label?: string[];
  assignee?: string;
  all?: boolean;
  limit?: number;
  query?: string;
}

export interface BlockInfo {
  blocked: boolean;
  blockers: string[];
}

export interface EpicStatus {
  epic: Issue;
  total: number;
  closed: number;
  inProgress: number;
  eligibleForClose: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function base36(buf: Buffer): string {
  let n = 0n;
  for (const b of buf.subarray(0, 8)) n = (n << 8n) | BigInt(b);
  return n.toString(36);
}

/** beads-compatible content hash id: sha256 of length-prefixed seed, base36, last N chars. */
export function hashId(seedParts: string[], length: number): string {
  const seed = seedParts.map((p) => `${Buffer.byteLength(p)}:${p}`).join('');
  const s = base36(crypto.createHash('sha256').update(seed).digest()).padStart(length, '0');
  return s.slice(s.length - length);
}

function optimalLength(count: number): number {
  for (let len = 3; len <= 8; len++) {
    const space = 36 ** len;
    const p = 1 - Math.exp(-(count * count) / (2 * space));
    if (p < 0.25) return len;
  }
  return 8;
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class TrackerError extends Error {}

export class TrackerStore {
  readonly dir: string;
  readonly root: string;
  private issues = new Map<string, Issue>();
  private loadedMtime = -1;
  readonly actor: string;
  private listeners = new Set<() => void>();

  constructor(dir: string, actor?: string) {
    this.dir = dir;
    this.root = path.dirname(dir);
    this.actor = actor ?? process.env.ALTERAN_ACTOR ?? process.env.BEADS_ACTOR ?? os.userInfo().username;
    this.reload(true);
  }

  /** Find `.beads/` between cwd and the project root (never above it, so a stray ~/.beads is not picked up). */
  static discover(cwd: string, stopAt?: string): TrackerStore | null {
    let dir = path.resolve(cwd);
    const stop = path.resolve(stopAt ?? projectRoot(cwd));
    for (;;) {
      const candidate = path.join(dir, BEADS_DIR);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return new TrackerStore(candidate);
      const parent = path.dirname(dir);
      if (dir === stop || parent === dir) return null;
      dir = parent;
    }
  }

  static init(root: string, prefix?: string): TrackerStore {
    const dir = path.join(root, BEADS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const p = prefix ?? (slugify(path.basename(root)).split('-')[0] || 'bd');
    const cfg = path.join(dir, 'config.yaml');
    if (!fs.existsSync(cfg)) {
      fs.writeFileSync(cfg, `# Beads Project Configuration\nissue_prefix: ${p}\n# default_priority: 2\n# default_type: task\n`);
    }
    const meta = path.join(dir, 'metadata.json');
    if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ database: 'beads.db', jsonl_export: JSONL }, null, 2) + '\n');
    const jsonl = path.join(dir, JSONL);
    if (!fs.existsSync(jsonl)) fs.writeFileSync(jsonl, '');
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*.db\n*.db-*\n*.lock\nalteran.lock\n');
    return new TrackerStore(dir);
  }

  get jsonlPath() {
    return path.join(this.dir, JSONL);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get prefix(): string {
    try {
      const cfg = fs.readFileSync(path.join(this.dir, 'config.yaml'), 'utf8');
      const m = cfg.match(/^\s*issue_prefix:\s*["']?([A-Za-z0-9_-]+)/m);
      if (m) return m[1];
    } catch {}
    const counts = new Map<string, number>();
    for (const id of this.issues.keys()) {
      const m = id.match(/^([A-Za-z0-9_]+)-/);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best?.[0] ?? (slugify(path.basename(this.root)).split('-')[0] || 'bd');
  }

  // ---------------------------------------------------------------- io

  reload(force = false) {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.jsonlPath).mtimeMs;
    } catch {
      this.issues.clear();
      this.loadedMtime = 0;
      return;
    }
    if (!force && mtime === this.loadedMtime) return;
    const next = new Map<string, Issue>();
    const text = fs.readFileSync(this.jsonlPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const issue = JSON.parse(line) as Issue;
        if (issue.id) next.set(issue.id, issue);
      } catch {
        // Skip malformed lines (merge conflicts etc.); br doctor can repair them.
      }
    }
    this.issues = next;
    this.loadedMtime = mtime;
  }

  private save() {
    const lines = [...this.issues.values()]
      .filter((i) => !i.ephemeral)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(serializeIssue);
    const tmp = `${this.jsonlPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''));
    fs.renameSync(tmp, this.jsonlPath);
    this.loadedMtime = fs.statSync(this.jsonlPath).mtimeMs;
    for (const fn of this.listeners) fn();
  }

  private withLock<T>(fn: () => T): T {
    const lock = path.join(this.dir, 'alteran.lock');
    const deadline = Date.now() + 10_000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lock, 'wx');
      } catch {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true });
        } catch {}
        if (Date.now() > deadline) throw new TrackerError('Tracker is locked by another process (.beads/alteran.lock)');
        sleepSync(25);
      }
    }
    try {
      this.reload();
      const result = fn();
      this.save();
      return result;
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }

  private touch(id: string) {
    try {
      fs.writeFileSync(path.join(this.dir, 'last-touched'), id + '\n');
    } catch {}
  }

  // ---------------------------------------------------------------- lookup

  all(includeTombstones = false): Issue[] {
    this.reload();
    return [...this.issues.values()].filter((i) => includeTombstones || i.status !== 'tombstone');
  }

  /** Resolve an id: exact, with project prefix added, or unique partial match. */
  resolveId(ref: string): string {
    this.reload();
    const r = ref.trim();
    if (this.issues.has(r)) return r;
    const withPrefix = `${this.prefix}-${r}`;
    if (this.issues.has(withPrefix)) return withPrefix;
    const matches = [...this.issues.keys()].filter((id) => id.endsWith(`-${r}`) || id.includes(r));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new TrackerError(`Ambiguous id "${ref}": ${matches.slice(0, 5).join(', ')}`);
    throw new TrackerError(`Issue not found: ${ref}`);
  }

  get(ref: string): Issue {
    return this.issues.get(this.resolveId(ref))!;
  }

  tryGet(ref: string): Issue | undefined {
    try {
      return this.get(ref);
    } catch {
      return undefined;
    }
  }

  parentOf(issue: Issue): string | undefined {
    return issue.dependencies?.find((d) => d.type === 'parent-child')?.depends_on_id;
  }

  children(parentRef: string): Issue[] {
    const id = this.resolveId(parentRef);
    return this.all().filter((i) => i.dependencies?.some((d) => d.type === 'parent-child' && d.depends_on_id === id));
  }

  /** Issues that depend on `ref` (reverse edges). */
  dependents(ref: string): Array<{ issue: Issue; type: DepType }> {
    const id = this.resolveId(ref);
    const out: Array<{ issue: Issue; type: DepType }> = [];
    for (const i of this.all()) for (const d of i.dependencies ?? []) if (d.depends_on_id === id) out.push({ issue: i, type: d.type });
    return out;
  }

  // ---------------------------------------------------------------- readiness

  /** beads semantics: blocking deps gate an issue; blocked parents propagate down; epics wait for open children. */
  blockInfo(): Map<string, BlockInfo> {
    const issues = this.all();
    const byId = new Map(issues.map((i) => [i.id, i]));
    const base = new Map<string, string[]>();
    for (const i of issues) {
      const blockers: string[] = [];
      for (const d of i.dependencies ?? []) {
        if (!BLOCKING_DEP_TYPES.has(d.type)) continue;
        const target = byId.get(d.depends_on_id);
        if (target && !isClosedStatus(target.status)) blockers.push(target.id);
      }
      base.set(i.id, blockers);
    }
    const result = new Map<string, BlockInfo>();
    const visiting = new Set<string>();
    const resolve = (id: string): string[] => {
      const cached = result.get(id);
      if (cached) return cached.blockers;
      if (visiting.has(id)) return [];
      visiting.add(id);
      const own = [...(base.get(id) ?? [])];
      const issue = byId.get(id);
      const parent = issue ? this.parentOf(issue) : undefined;
      if (parent && byId.has(parent) && !isClosedStatus(byId.get(parent)!.status)) {
        const pb = resolve(parent);
        if (pb.length) own.push(`${parent} (parent blocked)`);
      }
      visiting.delete(id);
      result.set(id, { blocked: own.length > 0, blockers: own });
      return own;
    };
    for (const i of issues) resolve(i.id);
    for (const i of issues) {
      if (i.issue_type !== 'epic') continue;
      const open = issues.filter(
        (c) => !isClosedStatus(c.status) && c.dependencies?.some((d) => d.type === 'parent-child' && d.depends_on_id === i.id),
      );
      if (open.length) {
        const info = result.get(i.id)!;
        info.blocked = true;
        info.blockers.push(...open.map((c) => `${c.id} (open child)`));
      }
    }
    return result;
  }

  ready(opts: { limit?: number; type?: IssueType[]; priority?: number[]; label?: string[]; parent?: string } = {}): Issue[] {
    const info = this.blockInfo();
    const now = Date.now();
    const parentId = opts.parent ? this.resolveId(opts.parent) : undefined;
    let list = this.all().filter(
      (i) =>
        i.status === 'open' &&
        !info.get(i.id)?.blocked &&
        !(i.defer_until && Date.parse(i.defer_until) > now) &&
        !i.is_template,
    );
    if (opts.type?.length) list = list.filter((i) => opts.type!.includes(i.issue_type));
    if (opts.priority?.length) list = list.filter((i) => opts.priority!.includes(i.priority));
    if (opts.label?.length) list = list.filter((i) => opts.label!.every((l) => i.labels?.includes(l)));
    if (parentId) list = list.filter((i) => this.parentOf(i) === parentId);
    list.sort((a, b) => {
      const ha = a.priority <= 1 ? 0 : 1;
      const hb = b.priority <= 1 ? 0 : 1;
      return ha - hb || a.created_at.localeCompare(b.created_at);
    });
    return opts.limit ? list.slice(0, opts.limit) : list;
  }

  blocked(): Array<{ issue: Issue; blockers: string[] }> {
    const info = this.blockInfo();
    return this.all()
      .filter((i) => !isClosedStatus(i.status) && info.get(i.id)?.blocked)
      .map((i) => ({ issue: i, blockers: info.get(i.id)!.blockers }));
  }

  list(f: ListFilter = {}): Issue[] {
    let list = this.all();
    if (f.status?.length) list = list.filter((i) => f.status!.includes(i.status));
    else if (!f.all) list = list.filter((i) => !isClosedStatus(i.status));
    if (f.type?.length) list = list.filter((i) => f.type!.includes(i.issue_type));
    if (f.priority?.length) list = list.filter((i) => f.priority!.includes(i.priority));
    if (f.label?.length) list = list.filter((i) => f.label!.every((l) => i.labels?.includes(l)));
    if (f.assignee) list = list.filter((i) => i.assignee === f.assignee);
    if (f.parent) {
      const pid = this.resolveId(f.parent);
      list = list.filter((i) => this.parentOf(i) === pid);
    }
    if (f.query) {
      const q = f.query.toLowerCase();
      list = list.filter((i) =>
        [i.id, i.title, i.description, i.notes, i.design, i.acceptance_criteria].some((s) => s?.toLowerCase().includes(q)),
      );
    }
    list.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
    return f.limit ? list.slice(0, f.limit) : list;
  }

  epics(): EpicStatus[] {
    return this.all()
      .filter((i) => i.issue_type === 'epic')
      .map((epic) => {
        const kids = this.children(epic.id);
        const closed = kids.filter((k) => isClosedStatus(k.status)).length;
        return {
          epic,
          total: kids.length,
          closed,
          inProgress: kids.filter((k) => k.status === 'in_progress').length,
          eligibleForClose: kids.length > 0 && closed === kids.length && !isClosedStatus(epic.status),
        };
      })
      .sort((a, b) => a.epic.created_at.localeCompare(b.epic.created_at));
  }

  /** Find a phase epic by number ("2"), id, or name fragment. */
  findPhase(ref: string): Issue | undefined {
    const epics = this.all().filter((i) => i.issue_type === 'epic');
    const n = ref.match(/^\s*(\d+)\s*$/)?.[1];
    if (n) {
      const re = new RegExp(`^\\s*(phase|фаза|этап)\\s*${n}\\b`, 'i');
      return epics.find((e) => re.test(e.title)) ?? epics.find((e) => new RegExp(`\\b${n}\\b`).test(e.title.split(':')[0]));
    }
    const byId = this.tryGet(ref);
    if (byId?.issue_type === 'epic') return byId;
    const q = ref.toLowerCase();
    return epics.find((e) => e.title.toLowerCase().includes(q));
  }

  /** Phase number from an epic title such as "Phase 3: ..." / "Фаза 3". */
  static phaseNumber(epic: Issue): number | undefined {
    const m = epic.title.match(/^\s*(?:phase|фаза|этап)\s*(\d+)/i);
    return m ? Number(m[1]) : undefined;
  }

  // ---------------------------------------------------------------- mutations

  private nextId(input: CreateInput, createdAt: string, parentId?: string): string {
    if (parentId) {
      const re = new RegExp(`^${parentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
      let max = 0;
      for (const id of this.issues.keys()) {
        const m = id.match(re);
        if (m) max = Math.max(max, Number(m[1]));
      }
      return `${parentId}.${max + 1}`;
    }
    const prefix = this.prefix;
    const slug = input.slug ? slugify(input.slug) : '';
    let length = optimalLength(this.issues.size + 1);
    for (;;) {
      for (let nonce = 0; nonce < 10; nonce++) {
        const h = hashId([input.title, input.description ?? '', this.actor, String(Date.parse(createdAt) * 1e6), String(nonce)], length);
        const id = slug ? `${prefix}-${slug}-${h}` : `${prefix}-${h}`;
        if (!this.issues.has(id)) return id;
      }
      length = Math.min(length + 1, 12);
    }
  }

  private parseDepSpec(spec: string): { type: DepType; id: string } {
    const idx = spec.indexOf(':');
    if (idx > 0 && (DEP_TYPES as readonly string[]).includes(spec.slice(0, idx))) {
      return { type: spec.slice(0, idx), id: this.resolveId(spec.slice(idx + 1)) };
    }
    return { type: 'blocks', id: this.resolveId(spec) };
  }

  create(input: CreateInput): Issue {
    if (!input.title?.trim()) throw new TrackerError('Title is required');
    const type = input.type ?? 'task';
    if (!(ISSUE_TYPES as readonly string[]).includes(type)) throw new TrackerError(`Invalid type "${type}" (${ISSUE_TYPES.join(', ')})`);
    return this.withLock(() => {
      const createdAt = nowIso();
      const parentId = input.parent ? this.resolveId(input.parent) : undefined;
      const id = this.nextId(input, createdAt, parentId);
      const issue: Issue = {
        id,
        title: input.title.trim(),
        description: input.description,
        design: input.design,
        acceptance_criteria: input.acceptance_criteria,
        notes: input.notes,
        status: input.status ?? 'open',
        priority: normalizePriority(input.priority),
        issue_type: type,
        assignee: input.assignee,
        estimated_minutes: input.estimated_minutes,
        created_at: createdAt,
        created_by: this.actor,
        updated_at: createdAt,
        external_ref: input.external_ref,
        due_at: input.due_at,
        defer_until: input.defer_until,
        source_repo: path.basename(this.root),
        compaction_level: 0,
        original_size: 0,
        labels: input.labels?.length ? [...new Set(input.labels)] : undefined,
        dependencies: [],
      };
      if (issue.status === 'closed') issue.closed_at = createdAt;
      if (parentId) issue.dependencies!.push(this.dep(id, parentId, 'parent-child', createdAt));
      for (const spec of input.deps ?? []) {
        const { type: t, id: target } = this.parseDepSpec(spec);
        issue.dependencies!.push(this.dep(id, target, t, createdAt));
      }
      this.issues.set(id, issue);
      this.touch(id);
      return issue;
    });
  }

  private dep(issueId: string, dependsOn: string, type: DepType, createdAt = nowIso()): Dependency {
    return { issue_id: issueId, depends_on_id: dependsOn, type, created_at: createdAt, created_by: this.actor, metadata: '{}', thread_id: '' };
  }

  update(ref: string, patch: UpdateInput): Issue {
    return this.withLock(() => {
      const issue = this.issues.get(this.resolveId(ref))!;
      const now = nowIso();
      if (patch.title?.trim()) issue.title = patch.title.trim();
      for (const k of ['description', 'design', 'acceptance_criteria', 'notes', 'assignee'] as const) {
        if (patch[k] !== undefined) issue[k] = patch[k] || undefined;
      }
      if (patch.append_notes) issue.notes = issue.notes ? `${issue.notes}\n\n${patch.append_notes}` : patch.append_notes;
      if (patch.estimated_minutes !== undefined) issue.estimated_minutes = patch.estimated_minutes;
      if (patch.priority !== undefined) issue.priority = normalizePriority(patch.priority);
      if (patch.type !== undefined) issue.issue_type = patch.type;
      if (patch.defer_until !== undefined) issue.defer_until = patch.defer_until ?? undefined;
      if (patch.due_at !== undefined) issue.due_at = patch.due_at ?? undefined;
      if (patch.status !== undefined && patch.status !== issue.status) {
        issue.status = patch.status;
        if (patch.status === 'closed') issue.closed_at = now;
        else {
          delete issue.closed_at;
          delete issue.close_reason;
        }
      }
      if (patch.add_labels?.length) issue.labels = [...new Set([...(issue.labels ?? []), ...patch.add_labels])];
      if (patch.remove_labels?.length) issue.labels = (issue.labels ?? []).filter((l) => !patch.remove_labels!.includes(l));
      issue.updated_at = now;
      this.touch(issue.id);
      return issue;
    });
  }

  close(ref: string, reason?: string, opts: { force?: boolean } = {}): Issue {
    return this.withLock(() => {
      const issue = this.issues.get(this.resolveId(ref))!;
      if (issue.issue_type === 'epic' && !opts.force) {
        const open = [...this.issues.values()].filter(
          (c) => !isClosedStatus(c.status) && c.dependencies?.some((d) => d.type === 'parent-child' && d.depends_on_id === issue.id),
        );
        if (open.length) throw new TrackerError(`Epic ${issue.id} still has ${open.length} open children (${open.map((c) => c.id).join(', ')}). Use --force to close anyway.`);
      }
      const now = nowIso();
      issue.status = 'closed';
      issue.closed_at = now;
      issue.updated_at = now;
      if (reason) issue.close_reason = reason;
      this.touch(issue.id);
      return issue;
    });
  }

  reopen(ref: string, reason?: string): Issue {
    return this.withLock(() => {
      const issue = this.issues.get(this.resolveId(ref))!;
      issue.status = 'open';
      delete issue.closed_at;
      delete issue.close_reason;
      issue.updated_at = nowIso();
      if (reason) this.pushComment(issue, `Reopened: ${reason}`);
      return issue;
    });
  }

  delete(ref: string, reason?: string): Issue {
    return this.withLock(() => {
      const issue = this.issues.get(this.resolveId(ref))!;
      const now = nowIso();
      issue.original_type = issue.issue_type;
      issue.status = 'tombstone';
      issue.deleted_at = now;
      issue.deleted_by = this.actor;
      issue.delete_reason = reason ?? 'deleted';
      issue.updated_at = now;
      return issue;
    });
  }

  /** Would adding issue → dependsOn create a cycle among blocking/parent edges? */
  private createsCycle(issueId: string, dependsOn: string): boolean {
    const stack = [dependsOn];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === issueId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of this.issues.get(cur)?.dependencies ?? []) {
        if (BLOCKING_DEP_TYPES.has(d.type) || d.type === 'parent-child') stack.push(d.depends_on_id);
      }
    }
    return false;
  }

  addDep(issueRef: string, dependsOnRef: string, type: DepType = 'blocks'): Dependency {
    if (!(DEP_TYPES as readonly string[]).includes(type)) throw new TrackerError(`Invalid dependency type "${type}"`);
    return this.withLock(() => {
      const issueId = this.resolveId(issueRef);
      const target = this.resolveId(dependsOnRef);
      if (issueId === target) throw new TrackerError('An issue cannot depend on itself');
      const issue = this.issues.get(issueId)!;
      const existing = issue.dependencies?.find((d) => d.depends_on_id === target && d.type === type);
      if (existing) return existing;
      if ((BLOCKING_DEP_TYPES.has(type) || type === 'parent-child') && this.createsCycle(issueId, target)) {
        throw new TrackerError(`Adding ${issueId} -> ${target} would create a dependency cycle`);
      }
      const dep = this.dep(issueId, target, type);
      issue.dependencies = [...(issue.dependencies ?? []), dep];
      issue.updated_at = nowIso();
      return dep;
    });
  }

  removeDep(issueRef: string, dependsOnRef: string): number {
    return this.withLock(() => {
      const issue = this.issues.get(this.resolveId(issueRef))!;
      const target = this.resolveId(dependsOnRef);
      const before = issue.dependencies?.length ?? 0;
      issue.dependencies = (issue.dependencies ?? []).filter((d) => d.depends_on_id !== target);
      issue.updated_at = nowIso();
      return before - issue.dependencies.length;
    });
  }

  private pushComment(issue: Issue, text: string, author = this.actor): Comment {
    let maxId = 0;
    for (const i of this.issues.values()) for (const c of i.comments ?? []) maxId = Math.max(maxId, c.id);
    const c: Comment = { id: maxId + 1, issue_id: issue.id, author, text, created_at: nowIso() };
    issue.comments = [...(issue.comments ?? []), c];
    return c;
  }

  addComment(ref: string, text: string, author?: string): Comment {
    return this.withLock(() => {
      const issue = this.issues.get(this.resolveId(ref))!;
      issue.updated_at = nowIso();
      return this.pushComment(issue, text, author);
    });
  }

  stats() {
    const all = this.all();
    const by = (key: (i: Issue) => string) => {
      const m: Record<string, number> = {};
      for (const i of all) m[key(i)] = (m[key(i)] ?? 0) + 1;
      return m;
    };
    return {
      total: all.length,
      byStatus: by((i) => i.status),
      byType: by((i) => i.issue_type),
      byPriority: by((i) => `P${i.priority}`),
      ready: this.ready().length,
      blocked: this.blocked().length,
    };
  }
}
