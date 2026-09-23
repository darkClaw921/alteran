import type { Entry } from './store.js';
import { fmtClock, markdown, plain, seg, truncate, withRight, wrapLine, type Line } from './lines.js';
import { cacheLine, contextBar, type ContextReport } from '../core/context.js';
import { centerGate, gateSize, renderGate } from './gate.js';
import { C, CONTEXT_COLORS } from './theme.js';

const cache = new WeakMap<object, { key: string; lines: Line[] }>();

let displayRoot = '';
/** Paths inside the working directory are shown relative to it. */
export function setDisplayRoot(dir: string) {
  displayRoot = dir.endsWith('/') ? dir : dir + '/';
}
export function shortenPaths(text: string): string {
  return displayRoot ? text.split(displayRoot).join('') : text;
}

/** Splash gate box; `gateSize` keeps the drawing itself round inside it. */
const GATE_W = 34;
const GATE_H = 13;

/** Startup screen: the dormant gate on the left, the session facts on the right. */
function splash(rows: Array<[string, string]>, hints: string[], width: number, tick: number): Line[] {
  const label = Math.max(...rows.map(([k]) => k.length)) + 2;
  const facts = (avail: number): Line[] => [
    [seg('A L T E R A N', C.gold, { bold: true })],
    [seg('ancient gate network // agent terminal', C.muted)],
    [],
    // Facts stay one line each: a wrapped path would push the hints off the gate.
    ...rows.map(([k, v]): Line => [seg(k.toUpperCase().padEnd(label), C.bronze), seg(truncate(v, Math.max(12, avail - label)), C.text)]),
    [],
    ...hints.map((h): Line => [seg(truncate(h, avail), C.muted)]),
  ];
  // Narrow consoles get the facts only — the gate needs its own columns beside them.
  if (width < GATE_W + 46) return [[], ...facts(width)];

  const size = gateSize(GATE_W, GATE_H);
  // Idle dialling: chevrons lock one by one, hold for a beat, then the gate rests again.
  const phase = Math.floor(tick / 4) % 13;
  const art = centerGate(
    renderGate(size.width, size.height, {
      chevrons: Array.from({ length: 9 }, (_, k) => (phase >= 12 ? 'off' : k < phase ? 'lit' : k === phase ? 'active' : 'off')),
      active: false,
      dialing: true,
      tick,
      label: '',
      sublabel: '',
    }),
    GATE_W,
  );
  const wrapped = facts(width - GATE_W - 3);
  const top = Math.max(0, Math.floor((size.height - wrapped.length) / 2));
  const out: Line[] = [[]];
  for (let i = 0; i < Math.max(size.height, wrapped.length + top); i++) {
    const left = art[i] ?? [seg(' '.repeat(GATE_W), C.bg)];
    const leftW = left.reduce((n, x) => n + x.text.length, 0);
    const right = wrapped[i - top] ?? [];
    out.push([...left, seg(' '.repeat(Math.max(1, GATE_W - leftW + 3)), C.bg), ...right]);
  }
  return out;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** /context: one coloured bar plus a row per section, matching the VIRES meter's colours. */
function contextReport(report: ContextReport, width: number): Line[] {
  const barW = Math.max(20, Math.min(56, width - 8));
  const out: Line[] = [
    [],
    [seg('CONTEXT  ', C.bronze, { bold: true }), seg(report.model, C.muted), seg(`   window ${fmtK(report.window)}`, C.dim)],
    [seg('  [', C.dim), ...contextBar(report, barW).map((s) => seg(s.text, CONTEXT_COLORS[s.key] ?? C.dim)), seg(']', C.dim)],
    [],
  ];
  for (const p of report.parts) {
    const color = CONTEXT_COLORS[p.key] ?? C.muted;
    const pct = `${((p.tokens / report.window) * 100).toFixed(1)}%`;
    out.push([
      seg(`  ${p.glyph} `, color),
      seg(p.label.padEnd(21), p.key === 'free' ? C.dim : C.text),
      seg(fmtK(p.tokens).padStart(7), color),
      seg(pct.padStart(7), C.muted),
      seg(p.detail ? `   ${truncate(p.detail, Math.max(0, width - 44))}` : '', C.dim),
    ]);
  }
  out.push([]);
  out.push([
    seg(
      report.measured
        ? `Last request measured ${fmtK(report.measured)} prompt tokens; the split is estimated.`
        : 'Nothing sent yet; the split is estimated.',
      C.dim,
    ),
  ]);
  // A caching regression is silent everywhere else: requests still succeed, they just cost more.
  const cached = report.cache.read;
  const total = cached + report.cache.written + report.cache.fresh;
  out.push(...wrapLine([seg(cacheLine(report), total && !cached ? C.amber : C.dim)], width));
  return out;
}

export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `${server} - ${tool} (MCP)`;
  }
  if (name.startsWith('tasks_')) return `Consilium.${name.slice(6)}`;
  return (
    {
      Grep: 'Search',
      Glob: 'Search',
      Edit: 'Update',
      MultiEdit: 'Update',
      TodoWrite: 'Update Todos',
      Task: 'Agent',
      ExitPlanMode: 'Plan ready',
      AskUserQuestion: 'Ask user',
      BashOutput: 'Bash output',
    }[name] ?? name
  );
}

const time = (ms: number): Line => [seg(fmtClock(ms), C.muted)];

function resultPrefix(first: boolean): Line {
  return first ? [seg('  L ', C.rule)] : [seg('    ', C.rule)];
}

function toolLines(e: Extract<Entry, { kind: 'tool' }>, width: number, expanded: boolean): Line[] {
  const out: Line[] = [];
  const sub = e.agentId !== 'main';
  const indent: Line = sub ? [seg('  | ', C.dim)] : [];
  const bulletColor = e.status === 'error' ? C.red : e.status === 'running' ? C.cyan : C.gold;
  const args = e.summary ? `(${shortenPaths(e.summary.replace(/\n/g, ' '))})` : '()';
  const head: Line = [...indent, seg('* ', bulletColor), seg(toolLabel(e.name), C.text, { bold: !sub }), seg(' '), seg(truncate(args, Math.max(10, width - 30)), C.cyan)];
  out.push(withRight(head, time(e.t), width));
  if (e.status === 'running') return out;
  const d = e.display;
  const push = (line: Line, first: boolean) => {
    for (const l of wrapLine([...indent, ...resultPrefix(first), ...line], width, (sub ? 4 : 0) + 4)) out.push(l);
  };

  if (e.status === 'error') {
    const text = shortenPaths(d?.summary ?? e.resultText?.split('\n')[0] ?? 'Error');
    push([seg(text, C.red)], true);
    if (expanded && e.resultText) e.resultText.split('\n').slice(1, 30).forEach((l) => push([seg(l, C.muted)], false));
    return out;
  }

  if (e.name === 'TodoWrite' && Array.isArray(e.input.todos)) {
    (e.input.todos as Array<{ content: string; status: string }>).forEach((t, i) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      const color = t.status === 'completed' ? C.green : t.status === 'in_progress' ? C.amber : C.muted;
      push([seg(`${mark} ${t.content}`, color)], i === 0);
    });
    return out;
  }

  const summary = shortenPaths(d?.summary ?? '');
  const moreHint = !expanded && ((d?.lines?.length ?? 0) > 0 || (d?.diff?.length ?? 0) > 12) ? ' (ctrl+o to expand)' : '';
  if (summary) push([seg(summary, C.muted), seg(moreHint, C.dim)], true);

  if (d?.diff?.length) {
    const lines = expanded ? d.diff : d.diff.filter((l) => l.kind !== 'ctx').slice(0, 12);
    const numW = Math.max(3, ...lines.map((l) => String(l.lineNo ?? '').length));
    for (const l of lines) {
      if (l.kind === 'sep') {
        push([seg(' '.repeat(numW) + ' ...', C.dim)], false);
        continue;
      }
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const color = l.kind === 'add' ? C.green : l.kind === 'del' ? C.red : C.muted;
      out.push(...wrapLine([...indent, ...resultPrefix(false), seg(String(l.lineNo ?? '').padStart(numW) + ' ', C.muted), seg(`${sign} ${l.text}`, color)], width, 4 + numW + 3));
    }
    return out;
  }

  if (expanded && d?.lines?.length) {
    for (const l of d.lines) push([seg(l, e.name === 'Bash' && /PASS|✓|passed/.test(l) ? C.green : e.name === 'Bash' && /FAIL|✗|error/i.test(l) ? C.red : C.muted)], false);
  } else if (e.name === 'Bash' && d?.lines?.length) {
    const tail = d.lines.filter((l) => l.trim()).slice(-3);
    if (tail.length > 1 || (tail[0] && tail[0] !== summary)) {
      tail.forEach((l) => push([seg(truncate(l, width - 8), /PASS|✓|passed/.test(l) ? C.green : /FAIL|✗|error/i.test(l) ? C.red : C.muted)], false));
    }
  } else if (e.name === 'Task' && e.resultText) {
    e.resultText
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, expanded ? 60 : 4)
      .forEach((l) => push([seg(l, C.muted)], false));
  }
  return out;
}

export function entryLines(e: Entry & { v: number }, width: number, expanded: boolean, tick = 0): Line[] {
  // Only the splash redraws with the clock; everything else stays cached by content.
  const key = `${e.v}:${width}:${expanded}:${e.kind === 'splash' ? tick : 0}`;
  const hit = cache.get(e);
  if (hit && hit.key === key) return hit.lines;
  const lines = computeLines(e, width, expanded, tick);
  cache.set(e, { key, lines });
  return lines;
}

function computeLines(e: Entry, width: number, expanded: boolean, tick = 0): Line[] {
  switch (e.kind) {
    case 'user': {
      const wrapped = wrapLine([seg('> ', C.muted), seg(e.text, C.text)], width - 10, 2);
      return [[], withRight(wrapped[0], time(e.t), width), ...wrapped.slice(1)];
    }
    case 'assistant': {
      const md = markdown(e.text.trim(), width - 2);
      if (!md.length) return [];
      const out: Line[] = [[]];
      md.forEach((l, i) => out.push(i === 0 ? [seg('* ', C.gold), ...l] : [seg('  '), ...l]));
      return out;
    }
    case 'thinking': {
      const text = e.text.trim();
      if (!text) return [];
      if (!expanded) {
        const last = text.split('\n').filter((l) => l.trim()).slice(-1)[0] ?? '';
        return [[seg('  ✻ ', C.dim), seg(truncate(e.live ? last : `thought for a while (ctrl+o to show)`, width - 6), C.dim, { italic: true })]];
      }
      return wrapLine([seg('  ✻ ', C.dim), seg(text, C.muted, { italic: true })], width, 4);
    }
    case 'tool':
      return [[], ...toolLines(e, width, expanded)];
    case 'agent': {
      const color = e.status === 'failed' ? C.red : e.status === 'done' ? C.green : e.status === 'stopped' ? C.muted : C.cyan;
      const mark = e.status === 'running' ? '>>' : e.status === 'done' ? '<<' : e.status === 'stopped' ? 'xx' : '!!';
      const tail = e.status === 'running' ? `${e.background ? 'background, ' : ''}${e.detail ?? 'thinking'}` : '';
      const head = withRight(
        [seg(`${mark} `, color), seg(e.label, C.text, { bold: true }), ...(e.name ? [seg(`  [${e.name}]`, C.dim)] : []), ...(tail ? [seg(`  ${tail}`, C.muted)] : [])],
        time(e.t),
        width,
      );
      const out: Line[] = [[], head];
      if (e.status !== 'running' && e.summary) {
        const lines = e.summary.split('\n').filter((l) => l.trim()).slice(0, expanded ? 40 : 3);
        for (const l of lines) out.push(...wrapLine([seg('  L ', C.rule), seg(l, C.muted)], width, 4));
      }
      return out;
    }
    case 'notice': {
      const color = e.level === 'error' ? C.red : e.level === 'warn' ? C.amber : C.muted;
      return [[], ...wrapLine([seg('* ', color), seg(e.text, color)], width, 2)];
    }
    case 'splash':
      return splash(e.rows, e.hints, width, tick);
    case 'context':
      return contextReport(e.report, width);
    case 'info':
      return [[], ...(e.title ? [[seg(e.title, C.bronze, { bold: true })]] : []), ...plain(e.text, C.text).flatMap((l) => wrapLine(l, width))];
    case 'error':
      return [[], ...wrapLine([seg('! ', C.red), seg(e.text, C.red)], width, 2)];
    case 'plan': {
      const rule = [seg('-- PLAN ' + '-'.repeat(Math.max(0, Math.min(width, 60) - 8)), C.bronze)];
      return [[], rule, ...markdown(e.text, width), [seg('-'.repeat(Math.min(width, 60)), C.bronze)]];
    }
    case 'diff': {
      const out: Line[] = [[]];
      for (const l of e.text.split('\n')) {
        const color = l.startsWith('+++') || l.startsWith('---') ? C.gold : l.startsWith('+') ? C.green : l.startsWith('-') ? C.red : l.startsWith('@@') ? C.cyan : l.startsWith('diff ') ? C.bronze : C.muted;
        out.push(...wrapLine([seg(l, color)], width));
      }
      return out;
    }
  }
}
