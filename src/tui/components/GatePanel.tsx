import { Box } from 'ink';
import { centerGate, gateSize, renderGate } from '../gate.js';
import { fmtClock, seg, truncate, type Line } from '../lines.js';
import type { UiStore } from '../store.js';
import { C } from '../theme.js';
import { scheduleLines, scheduleNote } from './SchedulePanel.js';
import { Lines } from './Lines.js';

function header(title: string, note: string, width: number, color: string = C.gold): Line {
  const left = `-- ${title} `;
  const right = note ? ` ${note}` : '';
  const fill = Math.max(0, width - left.length - right.length);
  return [seg(left, color, { bold: true }), seg('-'.repeat(fill), C.rule), seg(right, C.muted)];
}

/**
 * How many schedule rows the left panel has room for. Exported because a selection is an index
 * into the drawn rows: the keyboard must count them the way the panel does, or `x` cancels the
 * neighbour of what is highlighted.
 */
export function scheduleRowCount(store: UiStore, width: number, height: number): number {
  const inner = width - 4;
  const gateHeight = Math.max(9, Math.min(19, height - 26));
  const gate = gateSize(inner, gateHeight);
  return Math.max(3, height - gate.height - store.stages.stages.length - 14);
}

export function GatePanel({ store, width, height, scheduleSelected = -1 }: { store: UiStore; width: number; height: number; scheduleSelected?: number }) {
  const inner = width - 4;
  const st = store.stages;
  const chevrons = st.stages.map((s) => (s.state === 'done' ? 'lit' : s.state === 'active' ? 'active' : s.state === 'failed' ? 'failed' : 'off')) as Array<
    'off' | 'lit' | 'active' | 'failed'
  >;
  const git = store.git;
  const gateHeight = Math.max(9, Math.min(19, height - 26));
  const size = gateSize(inner, gateHeight);
  const gate = renderGate(size.width, size.height, {
    chevrons,
    active: store.running,
    tick: store.tick,
    label: store.awaiting ? '[ IRIS HOLD ]' : store.running ? '[ RUNNING ]' : '[ DORMANT ]',
    labelColor: store.awaiting ? C.amber : store.running ? C.gold : C.muted,
    sublabel: truncate(git?.branch ?? '', inner - 4),
  });

  const stageLines: Line[] = st.stages.map((s, i) => {
    const mark = s.state === 'done' ? '#' : s.state === 'active' ? '/' : s.state === 'failed' ? '!' : ' ';
    const color = s.state === 'done' ? C.green : s.state === 'active' ? C.amber : s.state === 'failed' ? C.red : C.muted;
    const label = st.label(s);
    const t = s.state === 'pending' ? '--' : `${(s.ms / 1000).toFixed(1)}s`;
    const dots = Math.max(1, inner - 10 - label.length - t.length);
    return [
      seg(`${i + 1} `, C.muted),
      seg(`[${mark}] `, color),
      seg(label, s.state === 'pending' ? C.muted : C.text),
      seg(' ' + '.'.repeat(dots) + ' ', C.dim),
      seg(t, s.state === 'pending' ? C.dim : C.muted),
    ];
  });

  const origin: Line[] = git?.isRepo
    ? [
        [seg('REPO    ', C.muted), seg(truncate(git.repo, inner - 8), C.text)],
        [
          seg('BRANCH  ', C.muted),
          seg(truncate(git.branch, inner - 20), C.cyan),
          seg(git.ahead ? `  ^${git.ahead} ahead` : '', C.amber),
          seg(git.behind ? `  v${git.behind} behind` : '', C.amber),
        ],
        [seg('HEAD    ', C.muted), seg(git.head, C.text), seg(git.dirty ? '  clean->dirty' : '  clean', git.dirty ? C.amber : C.green)],
      ]
    : [[seg('REPO    ', C.muted), seg('(not a git repository)', C.muted)]];

  const files = git?.files ?? [];
  const rows = scheduleRowCount(store, width, height);
  // Deferred work owns this slot: it is always visible, so an empty schedule reads as "nothing deferred"
  // rather than as a missing panel. The working tree keeps what is left over, and yields it once work is
  // actually queued.
  const schedule = scheduleLines(store.scheduled, inner, rows, scheduleSelected);
  const idle = store.scheduled.length === 0;
  // The tree lives on what the schedule leaves: its own header, the blank line above it, and the
  // "... n more" tail all come out of this budget, or the panel overflows and loses its footer.
  const treeRows = Math.max(1, rows - schedule.length - 3);
  const shown = files.slice(0, files.length > treeRows ? treeRows - 1 : treeRows);

  const tree: Line[] = shown.map((f) => {
    const stat = `+${f.added} -${f.removed}`;
    const statusColor = f.status === '??' ? C.muted : f.status.includes('A') ? C.green : f.status.includes('D') ? C.red : C.amber;
    const pathW = Math.max(6, inner - 4 - stat.length);
    return [seg(f.status.padEnd(3), statusColor), seg(truncate(f.path, pathW).padEnd(pathW), C.text), seg(stat, C.muted)];
  });
  if (files.length > shown.length) tree.push([seg(`... ${files.length - shown.length} more`, C.dim)]);
  if (!files.length) tree.push([seg('(working tree clean)', C.dim)]);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={2} paddingY={1} backgroundColor={C.panel} flexShrink={0} overflow="hidden">
      <Lines lines={[header('ASTRIA PORTA', `${st.locked} gradus`, inner)]} />
      <Lines lines={centerGate(gate, inner)} />
      <Box height={1} />
      <Lines lines={[header('GRADUS', store.running ? `pipeline ${st.locked}/9` : `run ${fmtClock(store.elapsed)}`, inner, C.bronze)]} />
      <Lines lines={stageLines} />
      <Box height={1} />
      <Lines lines={origin} />
      <Box height={1} />
      <Lines lines={[header('SCHEDULE', scheduleNote(store.scheduled), inner, C.bronze)]} />
      <Lines lines={schedule} />
      {idle ? (
        <>
          <Box height={1} />
          <Lines lines={[header('WORKING TREE', `${files.length} changed`, inner, C.bronze)]} />
          <Lines lines={tree} />
        </>
      ) : null}
      <Box flexGrow={1} />
      <Lines lines={[[seg('[F2] diff     [F3] tests', C.muted)], [seg('[F4] phases   [F5] rerun stage', C.muted)]]} />
    </Box>
  );
}
