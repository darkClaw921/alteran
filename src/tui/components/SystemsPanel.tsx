import { Box } from 'ink';
import { bar, fmtClock, fmtTokens, seg, truncate, wrapLine, type Line } from '../lines.js';
import type { UiStore } from '../store.js';
import type { Runtime } from '../../core/runtime.js';
import { contextBar } from '../../core/context.js';
import { C, CONTEXT_COLORS, type Color } from '../theme.js';
import { agentLines, agentsNote } from './AgentsPanel.js';
import { Lines } from './Lines.js';

function header(title: string, note: string, width: number, color: Color = C.gold): Line {
  const left = `-- ${title} `;
  const right = note ? ` ${note}` : '';
  return [seg(left, color, { bold: true }), seg('-'.repeat(Math.max(0, width - left.length - right.length)), C.rule), seg(right, C.muted)];
}

function meter(label: string, value: number, note: string, width: number, color: Color): Line {
  const barW = Math.max(6, Math.min(20, width - 18 - note.length));
  const ratio = Math.max(0, Math.min(1, value));
  const filled = bar(ratio, barW);
  const cut = filled.lastIndexOf('#') + 1;
  const pct = `${Math.round(ratio * 100)}%`.padStart(4);
  return [
    seg(label.padEnd(9), C.muted),
    seg('[', C.dim),
    seg(filled.slice(0, cut), color),
    seg(filled.slice(cut), C.dim),
    seg(']', C.dim),
    seg(pct + '  ', color),
    seg(note, C.muted),
  ];
}

/** CONTEXT meter, split by what the window is spent on (see /context). */
function contextMeter(store: UiStore, width: number): Line {
  const report = store.contextReport;
  // Before the first request there is nothing measured, so fall back to the estimate.
  const used = store.contextTokens || report?.used || 0;
  const note = `${store.contextTokens ? '' : '~'}${fmtTokens(used)}/${fmtTokens(store.contextWindow)}`;
  const ratio = store.contextWindow ? used / store.contextWindow : 0;
  if (!report) return meter('CONTEXT', ratio, note, width, ratio > 0.85 ? C.red : ratio > 0.6 ? C.amber : C.green);
  const barW = Math.max(6, Math.min(20, width - 18 - note.length));
  const pct = `${Math.round(ratio * 100)}%`.padStart(4);
  return [
    seg('CONTEXT'.padEnd(9), C.muted),
    seg('[', C.dim),
    ...contextBar(report, barW).map((sgm) => seg(sgm.text, CONTEXT_COLORS[sgm.key] ?? C.dim)),
    seg(']', C.dim),
    seg(pct + '  ', ratio > 0.85 ? C.red : ratio > 0.6 ? C.amber : C.green),
    seg(note, C.muted),
  ];
}

/** ASCII token-burn graph: one column per minute. */
function burnGraph(store: UiStore, width: number, height: number): Line[] {
  const buckets = store.burnBuckets(width);
  const max = Math.max(1000, ...buckets);
  const rows: Line[] = [];
  for (let r = height; r >= 1; r--) {
    const line: Line = [];
    for (const b of buckets) {
      const h = (b / max) * height;
      const ch = h >= r ? (h < r + 1 ? '^' : '|') : ' ';
      const color = h >= r ? (h < r + 1 ? C.cyan : C.bronze) : C.bg;
      const last = line[line.length - 1];
      if (last && last.color === color) last.text += ch;
      else line.push(seg(ch, color));
    }
    rows.push(line);
  }
  rows.push([seg('+' + '-'.repeat(Math.max(0, width - 1)), C.rule)]);
  rows.push([seg(`0m`, C.muted), seg(' '.repeat(Math.max(1, width - 5)), C.bg), seg('now', C.muted)]);
  return rows;
}

export function SystemsPanel({ store, rt, width, height }: { store: UiStore; rt: Runtime; width: number; height: number }) {
  const inner = width - 4;
  const tpm = store.tokensPerMinute();
  const rateCap = 120_000;
  const tests = store.stages.tests;
  const mcp = [...rt.mcp.servers.values()];
  const connected = mcp.filter((s) => s.status === 'connected').length;

  const bars: Line[] = [
    contextMeter(store, inner),
    meter('TOK RATE', tpm / rateCap, `${fmtTokens(tpm)} tok/m`, inner, C.cyan),
    tests?.total
      ? meter('TESTS', tests.passed / Math.max(1, tests.total), `${tests.passed}/${tests.total}`, inner, tests.failed ? C.red : C.green)
      : meter('TESTS', 0, 'not run', inner, C.dim),
    tests?.coverage != null
      ? meter('COVERAGE', tests.coverage / 100, 'covered', inner, C.green)
      : meter('MCP', mcp.length ? connected / mcp.length : 0, `${connected}/${mcp.length} servers`, inner, connected ? C.green : C.dim),
  ];

  // AGENTS only earns its space once something has been delegated.
  const agentRows = store.agentTree().length ? Math.max(2, Math.min(6, store.agentTree().length + (height > 44 ? 1 : 0))) : 0;
  const agents = agentRows ? agentLines(store, inner, agentRows) : [];

  const graphHeight = Math.max(4, Math.min(9, height - 34 - (agents.length ? agents.length + 2 : 0)));
  const graph = burnGraph(store, inner, graphHeight);

  const cons = store.consilium;
  const consRows = Math.max(3, Math.min(8, height - 30 - graphHeight - (agents.length ? agents.length + 2 : 0)));
  const items = cons.items
    .slice(0, consRows)
    .map((i) => [seg(i.mark + ' ', i.color), seg(truncate(i.title, inner - 4), i.color === C.muted ? C.muted : C.text)] as Line);
  if (cons.items.length > consRows) items.push([seg(`... ${cons.items.length - consRows} more`, C.dim)]);
  if (!items.length) items.push([seg('(no tasks)', C.dim)]);

  const events: Line[] = store.events.slice(0, 4).map((e) => {
    const t = fmtClock(Math.max(0, e.t - store.runStartedAt));
    const text = truncate(e.text, inner - t.length - 2);
    return [seg(text.padEnd(Math.max(0, inner - t.length - 1)), e.color), seg(t, C.muted)];
  });
  if (!events.length) events.push([seg('(no activity yet)', C.dim)]);

  const shield: Line[] = rt.permissions.shield().map((s) => {
    const color = s.state === 'on' ? C.green : s.state === 'partial' ? C.amber : C.muted;
    return [
      seg(s.label.padEnd(8), C.muted),
      seg(`[${s.state === 'on' ? '#' : s.state === 'partial' ? '/' : ' '}] `, color),
      seg(truncate(s.text, inner - 12), C.text),
    ];
  });

  const briefText = cons.source === 'tracker' && cons.current ? cons.current : store.lastPrompt || '(waiting for orders)';
  const brief = wrapLine([seg(briefText, C.text)], inner).slice(0, 3);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={2} paddingY={1} backgroundColor={C.panel} flexShrink={0} overflow="hidden">
      <Lines lines={[header('VIRES', 'resources', inner)]} />
      <Lines lines={bars} />
      <Box height={1} />
      <Lines lines={[header('NAQ DRAW', `last ${inner}m`, inner, C.bronze)]} />
      <Lines lines={graph} />
      <Box height={1} />
      <Lines lines={[header('CONSILIUM', `${cons.title} ${cons.note}`, inner)]} />
      <Lines lines={items} />
      <Box height={1} />
      {agents.length > 0 && (
        <>
          <Lines lines={[header('AGENTS', agentsNote(store), inner, C.bronze)]} />
          <Lines lines={agents} />
          <Box height={1} />
        </>
      )}
      <Lines lines={[header('EVENT LOG', '', inner, C.bronze)]} />
      <Lines lines={events} />
      <Box height={1} />
      <Lines lines={[header('CLIPEUS', 'iris shield', inner)]} />
      <Lines lines={shield} />
      <Box flexGrow={1} />
      <Lines lines={[header('TASK', '', inner, C.bronze), ...brief]} />
    </Box>
  );
}
