import { Command } from 'commander';
import { epicLine, issueDetails, issueLine } from './format.js';
import { paint, section, setColorEnabled } from '../util/color.js';
import { TrackerError, TrackerStore } from './store.js';
import { projectRoot } from '../config/paths.js';

const csv = (v: string, prev: string[] = []) => [...prev, ...v.split(',').map((s) => s.trim()).filter(Boolean)];
const collect = (v: string, prev: string[] = []) => [...prev, v];

interface Globals {
  json?: boolean;
  actor?: string;
  color?: boolean;
}

function openStore(g: Globals): TrackerStore {
  if ((g as { color?: boolean }).color === false) setColorEnabled(false);
  const store = TrackerStore.discover(process.cwd());
  if (!store) throw new TrackerError('No .beads directory found. Run `alteran tasks init` first.');
  if (g.actor) (store as { actor: string }).actor = g.actor;
  return store;
}

function out(g: Globals, data: unknown, human: () => string) {
  if (g.json) console.log(JSON.stringify(data, null, 2));
  else {
    const text = human();
    if (text) console.log(text);
  }
}

function run(fn: () => void) {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${paint.red('Error:')} ${msg}`);
    process.exitCode = 1;
  }
}

/** br-compatible command surface: `alteran tasks …` / `abr …`. */
export function buildTasksCommand(name = 'tasks'): Command {
  const cmd = new Command(name)
    .description('Built-in task tracker (CONSILIUM), compatible with beads_rust `br` and .beads/issues.jsonl')
    .option('--json', 'Output as JSON')
    .option('--actor <actor>', 'Actor name for audit trail')
    // Accepted for br compatibility; no effect (JSONL is the source of truth).
    .option('--db <db>')
    .option('--no-daemon')
    .option('--no-auto-flush')
    .option('--no-auto-import')
    .option('--allow-stale')
    .option('--lock-timeout <ms>')
    .option('--no-color', 'Disable coloured output')
    .option('-q, --quiet')
    .showHelpAfterError();

  const g = (): Globals => cmd.opts() as Globals;

  cmd
    .command('init')
    .description('Initialize a .beads workspace in the project root')
    .option('--prefix <prefix>', 'Issue id prefix')
    .action((o) =>
      run(() => {
        const existing = TrackerStore.discover(process.cwd());
        if (existing) return out(g(), { dir: existing.dir, prefix: existing.prefix }, () => `Already initialized: ${existing.dir}`);
        const store = TrackerStore.init(projectRoot(process.cwd()), o.prefix);
        out(g(), { dir: store.dir, prefix: store.prefix }, () => `${paint.green('Initialized')} ${store.dir} ${paint.muted(`(prefix: ${store.prefix})`)}`);
      }),
    );

  cmd
    .command('create')
    .alias('new')
    .description('Create a new issue')
    .argument('[title]')
    .option('--title <title>')
    .option('-t, --type <type>', 'task|bug|feature|epic|chore|docs|question', 'task')
    .option('-p, --priority <priority>', '0-4 or P0-P4', '2')
    .option('-d, --description <text>')
    .option('--body <text>')
    .option('--design <text>')
    .option('--acceptance <text>', 'Acceptance criteria')
    .option('--acceptance-criteria <text>')
    .option('--notes <text>')
    .option('-a, --assignee <who>')
    .option('-l, --labels <labels>', 'comma-separated', csv)
    .option('--parent <id>', 'Parent issue (creates parent-child dep)')
    .option('--deps <deps>', 'type:id,type:id', csv)
    .option('-e, --estimate <minutes>')
    .option('-s, --status <status>')
    .option('--slug <slug>')
    .option('--external-ref <ref>')
    .option('--silent', 'Print only the id')
    .action((title, o) =>
      run(() => {
        const store = openStore(g());
        const issue = store.create({
          title: o.title ?? title,
          type: o.type,
          priority: o.priority,
          description: o.description ?? o.body,
          design: o.design,
          acceptance_criteria: o.acceptance ?? o.acceptanceCriteria,
          notes: o.notes,
          assignee: o.assignee,
          labels: o.labels,
          parent: o.parent,
          deps: o.deps,
          estimated_minutes: o.estimate ? Number(o.estimate) : undefined,
          status: o.status,
          slug: o.slug,
          external_ref: o.externalRef,
        });
        if (o.silent) return console.log(issue.id);
        out(g(), issue, () => `${paint.green('Created')} ${paint.cyan(issue.id)}: ${issue.title}`);
      }),
    );

  cmd
    .command('q')
    .description('Quick capture: create an issue and print only its id')
    .argument('<title...>')
    .option('-t, --type <type>', '', 'task')
    .option('-p, --priority <p>', '', '2')
    .action((title: string[], o) =>
      run(() => console.log(openStore(g()).create({ title: title.join(' '), type: o.type, priority: o.priority }).id)),
    );

  cmd
    .command('list')
    .alias('ls')
    .description('List issues (open by default)')
    .option('-s, --status <status>', 'filter (repeatable, comma-separated)', csv)
    .option('-t, --type <type>', 'filter', csv)
    .option('-p, --priority <p>', 'filter', csv)
    .option('--parent <id>')
    .option('-l, --label <label>', '', collect)
    .option('-a, --assignee <who>')
    .option('--all', 'Include closed issues')
    .option('--limit <n>')
    .action((o) =>
      run(() => {
        const store = openStore(g());
        const list = store.list({
          status: o.status,
          type: o.type,
          priority: o.priority?.map((p: string) => Number(p.replace(/^P/i, ''))),
          parent: o.parent,
          label: o.label,
          assignee: o.assignee,
          all: o.all,
          limit: o.limit ? Number(o.limit) : undefined,
        });
        out(g(), list, () => (list.length ? list.map((i) => issueLine(i, true)).join('\n') : 'No issues'));
      }),
    );

  cmd
    .command('ready')
    .description('List ready issues (open, unblocked, not deferred)')
    .option('--limit <n>', '', '20')
    .option('-t, --type <type>', '', csv)
    .option('-p, --priority <p>', '', csv)
    .option('-l, --label <label>', '', collect)
    .option('--parent <id>')
    .action((o) =>
      run(() => {
        const store = openStore(g());
        const list = store.ready({
          limit: Number(o.limit) || undefined,
          type: o.type,
          priority: o.priority?.map((p: string) => Number(p.replace(/^P/i, ''))),
          label: o.label,
          parent: o.parent,
        });
        out(g(), list, () => (list.length ? section(`READY ${list.length}`) + '\n' + list.map((i) => issueLine(i, true)).join('\n') : 'No ready issues'));
      }),
    );

  cmd
    .command('blocked')
    .description('List blocked issues')
    .action(() =>
      run(() => {
        const list = openStore(g()).blocked();
        out(g(), list.map((b) => ({ ...b.issue, blocked_by: b.blockers })), () =>
          list.length ? list.map((b) => `${issueLine(b.issue, true)}\n    ${paint.red('blocked by:')} ${paint.muted(b.blockers.join(', '))}`).join('\n') : 'No blocked issues',
        );
      }),
    );

  cmd
    .command('show')
    .description('Show issue details')
    .argument('<ids...>')
    .action((ids: string[]) =>
      run(() => {
        const store = openStore(g());
        const issues = ids.map((id) => store.get(id));
        out(g(), issues.length === 1 ? issues[0] : issues, () => issues.map((i) => issueDetails(store, i, true)).join('\n\n' + paint.dim('---') + '\n\n'));
      }),
    );

  cmd
    .command('update')
    .description('Update one or more issues')
    .argument('<ids...>')
    .option('-s, --status <status>')
    .option('--title <title>')
    .option('-d, --description <text>')
    .option('--design <text>')
    .option('--acceptance <text>')
    .option('--notes <text>')
    .option('--append-notes <text>')
    .option('-p, --priority <p>')
    .option('-t, --type <type>')
    .option('-a, --assignee <who>')
    .option('-e, --estimate <minutes>')
    .option('--add-label <label>', '', collect)
    .option('--remove-label <label>', '', collect)
    .option('--claim', 'Set in_progress and assign to the actor')
    .action((ids: string[], o) =>
      run(() => {
        const store = openStore(g());
        const updated = ids.map((id) =>
          store.update(id, {
            status: o.claim ? 'in_progress' : o.status,
            assignee: o.claim ? store.actor : o.assignee,
            title: o.title,
            description: o.description,
            design: o.design,
            acceptance_criteria: o.acceptance,
            notes: o.notes,
            append_notes: o.appendNotes,
            priority: o.priority,
            type: o.type,
            estimated_minutes: o.estimate ? Number(o.estimate) : undefined,
            add_labels: o.addLabel,
            remove_labels: o.removeLabel,
          }),
        );
        out(g(), updated.length === 1 ? updated[0] : updated, () => updated.map((i) => `${paint.cyan('Updated')} ${i.id} ${paint.muted(`(${i.status})`)}`).join('\n'));
      }),
    );

  cmd
    .command('close')
    .description('Close one or more issues')
    .argument('<ids...>')
    .option('-r, --reason <reason>')
    .option('-f, --force', 'Close epics with open children')
    .action((ids: string[], o) =>
      run(() => {
        const store = openStore(g());
        const closed = ids.map((id) => store.close(id, o.reason, { force: o.force }));
        out(g(), closed.length === 1 ? closed[0] : closed, () => closed.map((i) => paint.green(`Closed ${i.id}: ${i.title}`)).join('\n'));
      }),
    );

  cmd
    .command('reopen')
    .argument('<ids...>')
    .option('-r, --reason <reason>')
    .action((ids: string[], o) =>
      run(() => {
        const store = openStore(g());
        const list = ids.map((id) => store.reopen(id, o.reason));
        out(g(), list, () => list.map((i) => `Reopened ${i.id}`).join('\n'));
      }),
    );

  cmd
    .command('delete')
    .argument('<ids...>')
    .option('--reason <reason>')
    .option('--force')
    .action((ids: string[], o) =>
      run(() => {
        const store = openStore(g());
        const list = ids.map((id) => store.delete(id, o.reason));
        out(g(), list, () => list.map((i) => `Deleted ${i.id} (tombstone)`).join('\n'));
      }),
    );

  const dep = cmd.command('dep').description('Manage dependencies');
  dep
    .command('add')
    .description('<issue> depends on <depends-on>')
    .argument('<issue>')
    .argument('<dependsOn>')
    .option('-t, --type <type>', 'blocks|parent-child|related|...', 'blocks')
    .action((issue: string, on: string, o) =>
      run(() => {
        const d = openStore(g()).addDep(issue, on, o.type);
        out(g(), d, () => `${paint.green('Added dependency:')} ${paint.cyan(d.issue_id)} ${paint.dim(`--${d.type}-->`)} ${paint.cyan(d.depends_on_id)}`);
      }),
    );
  dep
    .command('remove')
    .alias('rm')
    .argument('<issue>')
    .argument('<dependsOn>')
    .action((issue: string, on: string) =>
      run(() => {
        const n = openStore(g()).removeDep(issue, on);
        out(g(), { removed: n }, () => `Removed ${n} dependency edge(s)`);
      }),
    );
  dep
    .command('list')
    .argument('<issue>')
    .action((id: string) =>
      run(() => {
        const store = openStore(g());
        const i = store.get(id);
        const rev = store.dependents(i.id);
        out(g(), { dependencies: i.dependencies ?? [], dependents: rev.map((r) => ({ id: r.issue.id, type: r.type })) }, () =>
          [
            'Depends on:',
            ...(i.dependencies ?? []).map((d) => `  ${d.type}: ${d.depends_on_id}`),
            'Dependents:',
            ...rev.map((r) => `  ${r.type}: ${r.issue.id}`),
          ].join('\n'),
        );
      }),
    );
  dep
    .command('tree')
    .argument('<issue>')
    .action((id: string) =>
      run(() => {
        const store = openStore(g());
        const lines: string[] = [];
        const walk = (ref: string, depth: number, seen: Set<string>) => {
          const i = store.tryGet(ref);
          if (!i) return lines.push(`${'  '.repeat(depth)}${ref} (missing)`);
          lines.push(`${'  '.repeat(depth)}${issueLine(i)}`);
          if (seen.has(i.id)) return;
          seen.add(i.id);
          for (const d of i.dependencies ?? []) if (d.type !== 'parent-child') walk(d.depends_on_id, depth + 1, seen);
        };
        walk(id, 0, new Set());
        out(g(), lines, () => lines.join('\n'));
      }),
    );

  const epic = cmd.command('epic').description('Epic (phase) management');
  epic
    .command('status')
    .alias('list')
    .option('--open', 'Only open epics')
    .action((o) =>
      run(() => {
        let list = openStore(g()).epics();
        if (o.open) list = list.filter((e) => e.epic.status !== 'closed');
        out(g(), list, () => (list.length ? list.map((e) => epicLine(e, true)).join('\n') : 'No epics'));
      }),
    );
  epic
    .command('close-eligible')
    .description('Close epics whose children are all closed')
    .action(() =>
      run(() => {
        const store = openStore(g());
        const closed = store.epics().filter((e) => e.eligibleForClose).map((e) => store.close(e.epic.id, 'All children closed'));
        out(g(), closed, () => (closed.length ? closed.map((i) => `Closed ${i.id}`).join('\n') : 'Nothing to close'));
      }),
    );

  cmd
    .command('phase')
    .description('Show a phase epic (by number, id or name) with its tasks')
    .argument('<ref>')
    .action((ref: string) =>
      run(() => {
        const store = openStore(g());
        const e = store.findPhase(ref);
        if (!e) throw new TrackerError(`Phase "${ref}" not found`);
        const kids = store.children(e.id);
        out(g(), { epic: e, children: kids }, () =>
          [epicLine(store.epics().find((x) => x.epic.id === e.id)!, true), ...kids.map((k) => '  ' + issueLine(k, true))].join('\n'),
        );
      }),
    );

  cmd
    .command('search')
    .argument('<query...>')
    .option('--all', 'Include closed')
    .action((q: string[], o) =>
      run(() => {
        const list = openStore(g()).list({ query: q.join(' '), all: o.all ?? true });
        out(g(), list, () => (list.length ? list.map((i) => issueLine(i, true)).join('\n') : 'No matches'));
      }),
    );

  const comments = cmd.command('comments').description('Manage comments');
  comments
    .command('add')
    .argument('<id>')
    .argument('<text...>')
    .action((id: string, text: string[]) =>
      run(() => {
        const c = openStore(g()).addComment(id, text.join(' '));
        out(g(), c, () => `Comment #${c.id} added to ${c.issue_id}`);
      }),
    );
  comments
    .command('list')
    .argument('<id>')
    .action((id: string) =>
      run(() => {
        const i = openStore(g()).get(id);
        out(g(), i.comments ?? [], () => (i.comments ?? []).map((c) => `[${c.created_at}] ${c.author}: ${c.text}`).join('\n') || 'No comments');
      }),
    );

  const label = cmd.command('label').description('Manage labels');
  label
    .command('add')
    .argument('<id>')
    .argument('<labels...>')
    .action((id: string, labels: string[]) =>
      run(() => {
        const i = openStore(g()).update(id, { add_labels: labels });
        out(g(), i, () => `${i.id}: ${i.labels?.join(', ')}`);
      }),
    );
  label
    .command('remove')
    .argument('<id>')
    .argument('<labels...>')
    .action((id: string, labels: string[]) =>
      run(() => {
        const i = openStore(g()).update(id, { remove_labels: labels });
        out(g(), i, () => `${i.id}: ${i.labels?.join(', ') || '(no labels)'}`);
      }),
    );

  for (const n of ['stats', 'status']) {
    cmd
      .command(n)
      .description('Project statistics')
      .action(() =>
        run(() => {
          const s = openStore(g()).stats();
          out(g(), s, () =>
            [
              section('CONSILIUM'),
              `${paint.muted('Total:')} ${paint.bold(String(s.total))}   ${paint.muted('Ready:')} ${paint.green(String(s.ready))}   ${paint.muted('Blocked:')} ${paint.red(String(s.blocked))}`,
              `${paint.muted('Status:')} ${Object.entries(s.byStatus).map(([k, v]) => `${paint.cyan(k)}=${v}`).join('  ')}`,
              `${paint.muted('Type:')} ${Object.entries(s.byType).map(([k, v]) => `${paint.cyan(k)}=${v}`).join('  ')}`,
              `${paint.muted('Priority:')} ${Object.entries(s.byPriority).map(([k, v]) => `${paint.cyan(k)}=${v}`).join('  ')}`,
            ].join('\n'),
          );
        }),
      );
  }

  cmd
    .command('count')
    .option('-s, --status <status>', '', csv)
    .action((o) => run(() => console.log(openStore(g()).list({ status: o.status, all: !o.status }).length)));

  cmd
    .command('sync')
    .description('No-op for compatibility: alteran writes .beads/issues.jsonl directly')
    .option('--flush-only')
    .option('--import-only')
    .action(() => run(() => out(g(), { ok: true, jsonl: openStore(g()).jsonlPath }, () => `JSONL is up to date: ${openStore(g()).jsonlPath}`)));

  cmd
    .command('where')
    .action(() => run(() => console.log(openStore(g()).dir)));

  return cmd;
}
