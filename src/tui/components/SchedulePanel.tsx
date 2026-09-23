import { seg, truncate, type Line } from '../lines.js';
import type { ScheduleView } from '../../core/schedule.js';
import { C } from '../theme.js';

const KIND_MARK: Record<ScheduleView['kind'], string> = { prompt: '@', command: '$', message: '>' };

function countdown(item: ScheduleView): string {
  if (item.state !== 'waiting') return item.state;
  const secs = Math.max(0, Math.round((item.dueAt - Date.now()) / 1000));
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}`;
  return `in ${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;
}

/** Deferred work: what fires, when, and whether it repeats. */
export function scheduleLines(items: ScheduleView[], width: number, rows: number): Line[] {
  if (!items.length) return [[seg('(nothing scheduled)', C.dim)]];
  const shown = items.slice(0, rows);
  const out: Line[] = shown.map((i) => {
    const color = i.state === 'running' ? C.amber : i.state === 'waiting' ? C.cyan : i.state === 'failed' ? C.red : C.muted;
    const right = `${i.everyMs ? '* ' : ''}${countdown(i)}`;
    // Whose item it is matters once agents defer work of their own.
    const label = i.owner === 'main' ? i.label : `${i.ownerName}: ${i.label}`;
    const left = `${KIND_MARK[i.kind]} ${i.id} `;
    const labelW = Math.max(6, width - left.length - right.length - 2);
    return [seg(left, color), seg(truncate(label, labelW).padEnd(labelW), C.text), seg(' ' + right, color)];
  });
  if (items.length > rows) out.push([seg(`... ${items.length - rows} more`, C.dim)]);
  return out;
}

/** Note for the panel header: how much deferred work is still coming. */
export function scheduleNote(items: ScheduleView[]): string {
  const pending = items.filter((i) => i.state === 'waiting' || i.state === 'running').length;
  return pending ? `${pending} pending` : items.length ? 'idle' : '';
}
