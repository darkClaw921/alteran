import React from 'react';
import { Box } from 'ink';
import type { CatalogModel, ModelRoute } from '../../providers/catalog.js';
import { filterModels, fmtContext, fmtMoney, fmtPrice } from '../../providers/catalog.js';
import { seg, truncate, wrapLine, type Line } from '../lines.js';
import { C } from '../theme.js';
import { Lines } from './Lines.js';

export interface PickerState {
  /** alteran provider id (anthropic, polza, openrouter…). */
  provider: string;
  providers: string[];
  models: CatalogModel[];
  query: string;
  index: number;
  pane: 'models' | 'routes';
  routes: ModelRoute[];
  routeIndex: number;
  /** Route pinned for the highlighted model, if any. */
  pinned?: string[];
  /** Providers ticked in the routes pane, in priority order. */
  chosen: string[];
  loading?: string;
  error?: string;
  /** The model in use, as "provider:model". */
  current: string;
}

/** Rows visible around the selection, so long catalogs scroll instead of overflowing. */
function window<T>(items: T[], index: number, rows: number): { slice: T[]; from: number } {
  if (items.length <= rows) return { slice: items, from: 0 };
  const from = Math.min(Math.max(0, index - Math.floor(rows / 2)), items.length - rows);
  return { slice: items.slice(from, from + rows), from };
}

export function ModelPickerView({ state, width, height }: { state: PickerState; width: number; height: number }) {
  const inner = width - 4;
  const lines: Line[] = [];
  const border = (title: string): Line => {
    const left = `+-- ${title} `;
    return [seg(left + '-'.repeat(Math.max(0, width - left.length - 1)) + '+', C.gold)];
  };
  const row = (line: Line): Line => {
    const w = line.reduce((s, x) => s + x.text.length, 0);
    return [seg('| ', C.gold), ...line, seg(' '.repeat(Math.max(0, inner - w)), C.bg), seg(' |', C.gold)];
  };
  const rule = (): Line => [seg('|', C.gold), seg('-'.repeat(Math.max(0, width - 2)), C.rule), seg('|', C.gold)];

  const models = filterModels(state.models, state.query);
  const model = models[state.index];
  const route = state.routes[state.routeIndex];
  const title = state.pane === 'routes' ? `PROVIDERS / ${truncate(model?.id ?? '', 40)}` : `MODEL / ${state.provider}`;
  lines.push(border(title));

  // Header: search box (models) or the model being routed (routes), plus counts.
  if (state.pane === 'models') {
    const count = `${models.length}${models.length !== state.models.length ? `/${state.models.length}` : ''} models`;
    lines.push(
      row([
        seg('search: ', C.muted),
        seg(state.query, C.text),
        seg('_', C.gold, { bold: true }),
        seg(' '.repeat(Math.max(1, inner - 9 - state.query.length - count.length)), C.bg),
        seg(count, C.dim),
      ]),
    );
  } else {
    const picked = state.chosen.length ? `order: ${state.chosen.join(' > ')}` : 'routing: automatic (cheapest available)';
    lines.push(row([seg(`${state.routes.length} providers`, C.muted), seg('   ', C.bg), seg(truncate(picked, Math.max(10, inner - 18)), state.chosen.length ? C.amber : C.dim)]));
  }
  lines.push(rule());

  const detailRows = 5;
  const listRows = Math.max(3, height - detailRows - 5);

  if (state.loading) {
    lines.push(row([seg(state.loading, C.cyan)]));
  } else if (state.error) {
    lines.push(row([seg(state.error, C.red)]));
  } else if (state.pane === 'models') {
    const { slice, from } = window(models, state.index, listRows);
    slice.forEach((m, i) => {
      const idx = from + i;
      const active = idx === state.index;
      const inUse = `${state.provider}:${m.id}` === state.current;
      const price = m.pricing ? `${fmtMoney(m.pricing.in, m.pricing.currency)}/${fmtMoney(m.pricing.out, m.pricing.currency)}` : '';
      const right = `${fmtContext(m.contextWindow).padStart(5)}  ${price.padStart(16)}`;
      const name = truncate(m.id, Math.max(10, inner - right.length - 5));
      lines.push(
        row([
          seg(active ? ' > ' : inUse ? ' * ' : '   ', active ? C.gold : inUse ? C.green : C.dim),
          seg(name, active ? C.text : inUse ? C.green : C.muted, { bold: active }),
          seg(' '.repeat(Math.max(1, inner - 3 - name.length - right.length)), C.bg),
          seg(right, active ? C.gold : C.dim),
        ]),
      );
    });
    if (!models.length) lines.push(row([seg('No model matches the filter.', C.dim)]));
  } else {
    const { slice, from } = window(state.routes, state.routeIndex, listRows);
    slice.forEach((r, i) => {
      const idx = from + i;
      const active = idx === state.routeIndex;
      const rank = state.chosen.indexOf(r.name);
      // A ticked provider shows its position in the fallback order, not just a cross.
      const box = rank >= 0 ? `[${rank + 1}]` : '[ ]';
      const price = r.pricing ? `${fmtMoney(r.pricing.in, r.pricing.currency)}/${fmtMoney(r.pricing.out, r.pricing.currency)}` : '';
      const right = `${fmtContext(r.contextWindow).padStart(5)}  ${price.padStart(16)}`;
      const name = truncate(r.name, Math.max(10, inner - right.length - 9));
      lines.push(
        row([
          seg(active ? ' > ' : '   ', C.gold),
          seg(`${box} `, rank >= 0 ? C.green : C.dim),
          seg(name, active ? C.text : rank >= 0 ? C.green : C.muted, { bold: active }),
          seg(' '.repeat(Math.max(1, inner - 7 - name.length - right.length)), C.bg),
          seg(right, active ? C.gold : C.dim),
        ]),
      );
    });
    if (!state.routes.length) lines.push(row([seg('This provider does not expose upstream routing.', C.dim)]));
  }

  lines.push(rule());

  // Details for whatever is highlighted.
  const detail: Line[] = [];
  if (state.pane === 'models' && model) {
    detail.push([
      seg(truncate(model.name ?? model.id, Math.max(20, inner - 24)), C.gold, { bold: true }),
      seg(`  ctx ${fmtContext(model.contextWindow)} · out ${fmtContext(model.maxOutput)}`, C.muted),
    ]);
    detail.push([
      seg(fmtPrice(model.pricing), C.text),
      seg(model.pricing?.cacheRead != null ? `  cache read ${fmtMoney(model.pricing.cacheRead, model.pricing.currency)}` : '', C.muted),
      seg(model.pricing?.cacheWrite != null ? ` · write ${fmtMoney(model.pricing.cacheWrite, model.pricing.currency)}` : '', C.muted),
    ]);
    detail.push([
      seg(model.modality ?? 'text->text', C.muted),
      seg(model.topProvider ? `  via ${model.topProvider}` : '', C.dim),
      seg(state.pinned?.length ? `  pinned: ${state.pinned.join(' > ')}` : '', C.amber),
    ]);
    if (model.description) detail.push([seg(truncate(model.description.replace(/\s+/g, ' '), inner), C.dim)]);
  } else if (state.pane === 'routes' && route) {
    detail.push([
      seg(route.name, C.gold, { bold: true }),
      seg(`  ctx ${fmtContext(route.contextWindow)} · out ${fmtContext(route.maxOutput)}`, C.muted),
      seg(route.moderated ? '  moderated' : '', C.amber),
      seg(route.ru ? '  data-in-RU' : '', C.green),
    ]);
    detail.push([seg(fmtPrice(route.pricing), C.text)]);
    const cache = [
      route.pricing?.cacheRead != null ? `read ${fmtMoney(route.pricing.cacheRead, route.pricing.currency)}` : '',
      route.pricing?.cacheWrite != null ? `write ${fmtMoney(route.pricing.cacheWrite, route.pricing.currency)}` : '',
    ].filter(Boolean);
    if (cache.length) detail.push([seg(`cache ${cache.join(' · ')} per 1M`, C.muted)]);
    if (route.params?.length) detail.push([seg(truncate(`params: ${route.params.join(', ')}`, inner), C.dim)]);
  }
  for (const d of detail.slice(0, detailRows - 1)) for (const l of wrapLine(d, inner).slice(0, 1)) lines.push(row(l));

  const hints =
    state.pane === 'models'
      ? [seg('^v', C.muted), seg(' select  ', C.dim), seg('->', C.muted), seg(' providers & prices  ', C.dim), seg('enter', C.muted), seg(' use  ', C.dim), seg('tab', C.muted), seg(' provider  ', C.dim), seg('^R', C.muted), seg(' refresh  ', C.dim), seg('esc', C.muted), seg(' close', C.dim)]
      : [seg('^v', C.muted), seg(' move  ', C.dim), seg('space', C.muted), seg(' tick (order = priority)  ', C.dim), seg('enter', C.muted), seg(' pin & use  ', C.dim), seg('a', C.muted), seg(' automatic  ', C.dim), seg('<-', C.muted), seg(' back  ', C.dim), seg('esc', C.muted), seg(' close', C.dim)];
  lines.push(row(hints));
  lines.push([seg('+' + '-'.repeat(Math.max(0, width - 2)) + '+', C.gold)]);

  return (
    <Box flexDirection="column" width={width}>
      <Lines lines={lines} />
    </Box>
  );
}
