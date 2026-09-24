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
/** The items the panel shows, in the order they are drawn; a selection is an index into this. */
export function scheduleRows(items: ScheduleView[], rows: number): ScheduleView[] {
  return items.slice(0, rows);
}

export function scheduleLines(items: ScheduleView[], width: number, rows: number, selected = -1): Line[] {
  if (!items.length) return [[seg('(nothing scheduled)', C.dim)]];
  const shown = scheduleRows(items, rows);
  const out: Line[] = shown.map((i, n) => {
    const color = i.state === 'running' ? C.amber : i.state === 'waiting' ? C.cyan : i.state === 'failed' ? C.red : C.muted;
    const right = `${i.everyMs ? '* ' : ''}${countdown(i)}`;
    // Whose item it is matters once agents defer work of their own.
    const label = i.owner === 'main' ? i.label : `${i.ownerName}: ${i.label}`;
    const left = `${n === selected ? '*' : KIND_MARK[i.kind]} ${i.id} `;
    const labelW = Math.max(6, width - left.length - right.length - 2);
    const focused = n === selected;
    return [seg(left, focused ? C.gold : color), seg(truncate(label, labelW).padEnd(labelW), focused ? C.gold : C.text, { bold: focused }), seg(' ' + right, focused ? C.gold : color)];
  });
  if (items.length > rows) out.push([seg(`... ${items.length - rows} more`, C.dim)]);
  return out;
}

/** Note for the panel header: how much deferred work is still coming. */
export function scheduleNote(items: ScheduleView[]): string {
  const pending = items.filter((i) => i.state === 'waiting' || i.state === 'running').length;
  return pending ? `${pending} pending` : items.length ? 'idle' : '';
}
