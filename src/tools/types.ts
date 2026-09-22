import type { z } from 'zod';
import type { JsonSchema, ToolResultContent } from '../types.js';
import type { Runtime } from '../core/runtime.js';
import type { AgentHandle } from '../core/agent.js';

export type ToolCategory = 'read' | 'write' | 'bash' | 'network' | 'meta' | 'mcp' | 'tasks';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'sep';
  lineNo?: number;
  text: string;
}

export interface ToolDisplay {
  /** One-line result summary shown under the call, e.g. "Read 142 lines". */
  summary?: string;
  /** Extra lines shown when expanded (ctrl+o). */
  lines?: string[];
  diff?: DiffLine[];
}

export interface ToolOutput {
  content: ToolResultContent;
  isError?: boolean;
  display?: ToolDisplay;
}

export interface ToolContext {
  runtime: Runtime;
  agent: AgentHandle;
  signal: AbortSignal;
  toolUseId: string;
}

export interface Tool<I = Record<string, unknown>> {
  name: string;
  description: string;
  /** zod schema (preferred) or raw JSON schema (MCP tools). */
  schema?: z.ZodType<I>;
  jsonSchema?: JsonSchema;
  category: ToolCategory;
  /** Safe to run in parallel and without permission prompts. */
  readOnly?: boolean | ((input: I) => boolean);
  /** Hidden from the model until surfaced (e.g. via ToolSearch). */
  deferred?: boolean;
  /** Short argument summary for the console: `Read(src/x.ts)`. */
  summarize?: (input: I) => string;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

export const ok = (content: ToolResultContent, display?: ToolDisplay): ToolOutput => ({ content, display });
export const fail = (message: string): ToolOutput => ({ content: message, isError: true, display: { summary: message.split('\n')[0] } });

export function isReadOnly(tool: Tool<any>, input: unknown): boolean {
  if (typeof tool.readOnly === 'function') return tool.readOnly(input as never);
  return Boolean(tool.readOnly);
}
