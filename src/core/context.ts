/**
 * What the context window is actually spent on.
 *
 * Only the total is measured (the provider reports prompt tokens); the split is estimated from
 * the text that goes into each part, which is why the sections are labelled as estimates.
 */
import type { Runtime } from './runtime.js';
import type { Agent } from './agent.js';
import { systemSections } from './prompt.js';
import { toolSpec } from '../tools/schema.js';
import { textOf } from '../types.js';

export type ContextPartKey = 'system' | 'instructions' | 'catalog' | 'tools' | 'mcp' | 'messages' | 'free';

export interface ContextPart {
  key: ContextPartKey;
  label: string;
  tokens: number;
  /** Bar glyph, so the breakdown stays readable without colour. */
  glyph: string;
  detail?: string;
}

export interface ContextReport {
  parts: ContextPart[];
  /** Estimated tokens in use (everything but `free`). */
  used: number;
  window: number;
  /** Prompt tokens of the last request, straight from the provider. */
  measured: number;
  model: string;
}

/** Rough token count: ~3.5 characters per token across code and prose. */
export const estimateTokens = (text: string): number => (text ? Math.ceil(text.length / 3.5) : 0);

export function contextBreakdown(rt: Runtime, agent: Agent = rt.main): ContextReport {
  const sections = systemSections(rt.ext, rt.envInfo(agent.model), rt.promptCaps(agent));
  const instructions = estimateTokens(sections.instructions);
  const catalog = estimateTokens(sections.agents) + estimateTokens(sections.skills);
  // Whatever the agent's own system prompt holds beyond those blocks is the base prompt.
  const system = Math.max(0, estimateTokens(agent.system) - instructions - catalog);

  let tools = 0;
  let mcp = 0;
  let toolCount = 0;
  let mcpCount = 0;
  for (const tool of rt.toolsFor(agent)) {
    const spec = toolSpec(tool);
    const size = estimateTokens(spec.name + spec.description + JSON.stringify(spec.inputSchema));
    if (spec.name.startsWith('mcp__')) {
      mcp += size;
      mcpCount++;
    } else {
      tools += size;
      toolCount++;
    }
  }

  let messages = 0;
  for (const m of agent.messages) {
    for (const b of m.content) {
      if (b.type === 'text' || b.type === 'thinking') messages += estimateTokens(b.text);
      else if (b.type === 'tool_use') messages += estimateTokens(b.name + JSON.stringify(b.input));
      else if (b.type === 'tool_result') messages += estimateTokens(textOf(b.content));
      else if (b.type === 'image') messages += 1600;
      else if (b.type === 'opaque') messages += estimateTokens(JSON.stringify(b.item));
    }
  }

  const window = rt.registry.info(agent.model).contextWindow;
  const parts: ContextPart[] = [
    { key: 'system', label: 'system prompt', tokens: system, glyph: '#' },
    { key: 'instructions', label: 'project instructions', tokens: instructions, glyph: '$', detail: rt.ext.instructions.map((i) => i.file.split('/').pop()).join(', ') },
    { key: 'catalog', label: 'agents & skills', tokens: catalog, glyph: '%', detail: `${rt.ext.agents.size} agents, ${rt.ext.skills.size} skills` },
    { key: 'tools', label: 'tool schemas', tokens: tools, glyph: '=', detail: `${toolCount} tools` },
    { key: 'mcp', label: 'MCP tool schemas', tokens: mcp, glyph: '~', detail: `${mcpCount} tools` },
    { key: 'messages', label: 'conversation', tokens: messages, glyph: '+', detail: `${agent.messages.length} messages` },
  ];
  const used = parts.reduce((s, p) => s + p.tokens, 0);
  parts.push({ key: 'free', label: 'free', tokens: Math.max(0, window - used), glyph: '-' });
  return { parts, used, window, measured: agent.contextTokens, model: agent.model.id };
}

/** Proportional bar: one glyph run per part, widths summing to `width`. */
export function contextBar(report: ContextReport, width: number): Array<{ key: ContextPartKey; text: string }> {
  const out: Array<{ key: ContextPartKey; text: string }> = [];
  let filled = 0;
  for (const p of report.parts) {
    if (p.key === 'free') continue;
    // Anything present gets at least one cell, otherwise small sections vanish entirely.
    const cells = p.tokens > 0 ? Math.max(1, Math.round((p.tokens / report.window) * width)) : 0;
    if (!cells) continue;
    const room = Math.min(cells, Math.max(0, width - 1 - filled));
    if (!room) break;
    out.push({ key: p.key, text: p.glyph.repeat(room) });
    filled += room;
  }
  if (filled < width) out.push({ key: 'free', text: '-'.repeat(width - filled) });
  return out;
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** Plain-text report for `/context` in headless mode and for the CLI. */
export function formatContext(report: ContextReport): string {
  const pct = (n: number) => `${((n / report.window) * 100).toFixed(1)}%`.padStart(6);
  const bar = contextBar(report, 40)
    .map((s) => s.text)
    .join('');
  const rows = report.parts.map((p) => `  ${p.glyph} ${p.label.padEnd(22)} ${fmt(p.tokens).padStart(7)} ${pct(p.tokens)}${p.detail ? `   ${p.detail}` : ''}`);
  return [
    `Context: ${report.model} — window ${fmt(report.window)}`,
    `  [${bar}]  ${fmt(report.used)} used (${((report.used / report.window) * 100).toFixed(1)}%)`,
    ...rows,
    '',
    report.measured
      ? `Last request measured ${fmt(report.measured)} prompt tokens; the split above is estimated (~3.5 chars per token).`
      : 'Nothing sent yet; the split above is estimated (~3.5 chars per token).',
  ].join('\n');
}
