import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerDef } from '../compat/types.js';
import type { JsonSchema, ToolResultContent } from '../types.js';
import { fail, ok, type Tool, type ToolOutput } from '../tools/types.js';
import { truncateMiddle } from '../tools/bash.js';

export type McpStatus = 'pending' | 'connected' | 'failed' | 'needs-auth' | 'disabled';

export interface McpServerState {
  def: McpServerDef;
  status: McpStatus;
  error?: string;
  client?: Client;
  tools: Tool<any>[];
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; required?: boolean }> }>;
  resources: number;
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
export const mcpToolName = (server: string, tool: string) => `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);

const CONNECT_TIMEOUT = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class McpManager {
  readonly servers = new Map<string, McpServerState>();
  private listeners = new Set<() => void>();

  constructor(
    defs: Iterable<McpServerDef>,
    private cwd: string,
  ) {
    for (const def of defs) this.servers.set(def.name, { def, status: 'pending', tools: [], prompts: [], resources: 0 });
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Connect to all servers in parallel; resolves when every attempt settled. */
  async connectAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => this.connect(s)));
  }

  private makeTransport(def: McpServerDef, kind: 'streamable' | 'sse'): Transport {
    const c = def.config;
    if (c.command) {
      return new StdioClientTransport({
        command: c.command,
        args: c.args ?? [],
        env: { ...getDefaultEnvironment(), ...(c.env ?? {}) },
        cwd: c.cwd ?? this.cwd,
        stderr: 'ignore',
      });
    }
    const url = new URL(c.url!);
    const headers = Object.fromEntries(Object.entries(c.headers ?? {}).filter(([, v]) => v !== ''));
    if (kind === 'sse' || c.type === 'sse') return new SSEClientTransport(url, { requestInit: { headers } });
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  async connect(state: McpServerState): Promise<void> {
    const attempts: Array<'streamable' | 'sse'> = state.def.config.command || state.def.config.type === 'sse' ? ['streamable'] : ['streamable', 'sse'];
    let lastErr: unknown;
    for (const kind of attempts) {
      const client = new Client({ name: 'alteran', version: '0.1.0' }, { capabilities: {} });
      try {
        await withTimeout(client.connect(this.makeTransport(state.def, kind)), CONNECT_TIMEOUT, `connect ${state.def.name}`);
        state.client = client;
        state.status = 'connected';
        state.error = undefined;
        await this.refresh(state);
        this.changed();
        return;
      } catch (e) {
        lastErr = e;
        await client.close().catch(() => {});
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    state.status = /401|unauthor|oauth/i.test(msg) ? 'needs-auth' : 'failed';
    state.error = msg.split('\n')[0].slice(0, 300);
    this.changed();
  }

  private async refresh(state: McpServerState) {
    const client = state.client!;
    const caps = client.getServerCapabilities() ?? {};
    state.tools = [];
    if (caps.tools) {
      let cursor: string | undefined;
      do {
        const res = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of res.tools) state.tools.push(this.wrapTool(state, t));
        cursor = res.nextCursor;
      } while (cursor);
    }
    if (caps.prompts) {
      try {
        const res = await client.listPrompts();
        state.prompts = res.prompts;
      } catch {}
    }
    if (caps.resources) {
      try {
        state.resources = (await client.listResources()).resources.length;
      } catch {}
    }
  }

  private wrapTool(
    state: McpServerState,
    t: { name: string; description?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; title?: string } },
  ): Tool<Record<string, unknown>> {
    const name = mcpToolName(state.def.name, t.name);
    return {
      name,
      category: 'mcp',
      description: `${t.description ?? t.annotations?.title ?? t.name}`.slice(0, 2000),
      jsonSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as JsonSchema,
      readOnly: Boolean(t.annotations?.readOnlyHint),
      summarize: (i) => {
        const s = JSON.stringify(i);
        return s.length > 100 ? s.slice(0, 97) + '...' : s;
      },
      run: async (input, ctx) => {
        if (!state.client) return fail(`MCP server ${state.def.name} is not connected (${state.error ?? state.status})`);
        try {
          const res = await state.client.callTool({ name: t.name, arguments: input }, undefined, {
            signal: ctx.signal,
            timeout: 10 * 60_000,
            resetTimeoutOnProgress: true,
          });
          return convertResult(res as { content?: unknown[]; isError?: boolean; structuredContent?: unknown });
        } catch (e) {
          return fail(`MCP ${state.def.name}.${t.name} failed: ${(e as Error).message}`);
        }
      },
    };
  }

  tools(): Tool<any>[] {
    return [...this.servers.values()].flatMap((s) => (s.status === 'connected' ? s.tools : []));
  }

  async getPrompt(server: string, prompt: string, args: Record<string, string>): Promise<string> {
    const s = this.servers.get(server);
    if (!s?.client) throw new Error(`MCP server ${server} not connected`);
    const res = await s.client.getPrompt({ name: prompt, arguments: args });
    return res.messages.map((m) => (m.content.type === 'text' ? m.content.text : `[${m.content.type}]`)).join('\n\n');
  }

  async listResources(server?: string) {
    const out: Array<{ server: string; uri: string; name?: string; mimeType?: string }> = [];
    for (const s of this.servers.values()) {
      if (!s.client || (server && s.def.name !== server) || !s.client.getServerCapabilities()?.resources) continue;
      try {
        for (const r of (await s.client.listResources()).resources) out.push({ server: s.def.name, uri: r.uri, name: r.name, mimeType: r.mimeType });
      } catch {}
    }
    return out;
  }

  async readResource(server: string, uri: string): Promise<string> {
    const s = this.servers.get(server);
    if (!s?.client) throw new Error(`MCP server ${server} not connected`);
    const res = await s.client.readResource({ uri });
    return res.contents.map((c) => ('text' in c ? String(c.text) : `[binary ${c.mimeType ?? ''}]`)).join('\n');
  }

  async reconnect(name: string) {
    const s = this.servers.get(name);
    if (!s) throw new Error(`Unknown MCP server ${name}`);
    await s.client?.close().catch(() => {});
    s.client = undefined;
    s.status = 'pending';
    this.changed();
    await this.connect(s);
  }

  async closeAll() {
    await Promise.all([...this.servers.values()].map((s) => s.client?.close().catch(() => {})));
  }
}

function convertResult(res: { content?: unknown[]; isError?: boolean; structuredContent?: unknown }): ToolOutput {
  const parts: Exclude<ToolResultContent, string> = [];
  for (const c of (res.content ?? []) as Array<Record<string, any>>) {
    if (c.type === 'text') parts.push({ type: 'text', text: truncateMiddle(String(c.text), 60_000) });
    else if (c.type === 'image') parts.push({ type: 'image', mediaType: c.mimeType, data: c.data });
    else if (c.type === 'resource') parts.push({ type: 'text', text: c.resource?.text ?? `[resource ${c.resource?.uri}]` });
    else if (c.type === 'resource_link') parts.push({ type: 'text', text: `[resource ${c.uri}] ${c.name ?? ''}` });
    else parts.push({ type: 'text', text: `[${c.type} content]` });
  }
  if (!parts.length && res.structuredContent) parts.push({ type: 'text', text: JSON.stringify(res.structuredContent, null, 2) });
  if (!parts.length) parts.push({ type: 'text', text: '(empty result)' });
  const firstText = parts.find((p) => p.type === 'text') as { text: string } | undefined;
  const summary =
    firstText?.text
      .split('\n')
      .find((l) => l.trim())
      ?.slice(0, 140) ?? 'Done';
  const out = ok(parts, { summary, lines: firstText?.text.split('\n').slice(0, 30) });
  if (res.isError) out.isError = true;
  return out;
}
