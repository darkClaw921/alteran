import React from 'react';
import { Box } from 'ink';
import { centerGate, gateSize, renderGate } from '../gate.js';
import { fmtClock, seg, truncate, type Line } from '../lines.js';
import type { UiStore } from '../store.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

function header(title: string, note: string, width: number, color: string = C.gold): Line {
  const left = `-- ${title} `;
  const right = note ? ` ${note}` : '';
  const fill = Math.max(0, width - left.length - right.length);
  return [seg(left, color, { bold: true }), seg('-'.repeat(fill), C.rule), seg(right, C.muted)];
}

export function GatePanel({ store, width, height }: { store: UiStore; width: number; height: number }) {
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
  const treeRows = Math.max(3, height - size.height - stageLines.length - 14);
  const tree: Line[] = files.slice(0, treeRows).map((f) => {
    const stat = `+${f.added} -${f.removed}`;
    const statusColor = f.status === '??' ? C.muted : f.status.includes('A') ? C.green : f.status.includes('D') ? C.red : C.amber;
    const pathW = Math.max(6, inner - 4 - stat.length);
    return [seg(f.status.padEnd(3), statusColor), seg(truncate(f.path, pathW).padEnd(pathW), C.text), seg(stat, C.muted)];
  });
  if (files.length > treeRows) tree.push([seg(`... ${files.length - treeRows} more`, C.dim)]);
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
      <Lines lines={[header('WORKING TREE', `${files.length} changed`, inner, C.bronze)]} />
      <Lines lines={tree} />
      <Box flexGrow={1} />
      <Lines
        lines={[
          [seg('[F2] diff     [F3] tests', C.muted)],
          [seg('[F4] phases   [F5] rerun stage', C.muted)],
        ]}
      />
    </Box>
  );
}
