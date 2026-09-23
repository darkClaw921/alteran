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

/**
 * What this client offers the server. Nothing, on purpose: MCP lets a client serve sampling,
 * elicitation and roots back to the server, and alteran implements none of them. Declaring a
 * capability we cannot honour would make a server call into a method that never answers, so the
 * set stays empty and a server that needs one gets a clear "method not found" instead of a hang.
 */
const CLIENT_CAPABILITIES = {};

/** Reconnection backoff after a dropped connection: 1s, 2s, 4s … capped, and never forever. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETRY_LIMIT = 5;

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

  /** Servers that lost their connection and are waiting out a backoff before another attempt. */
  private retries = new Map<string, { attempts: number; timer: NodeJS.Timeout }>();

  constructor(
    defs: Iterable<McpServerDef>,
    private cwd: string,
  ) {
    for (const def of defs) {
      // A server switched off in its own config is registered as such: it appears in `/mcp` with a
      // reason, instead of looking like a server that was never configured.
      const status: McpStatus = def.config.disabled ? 'disabled' : 'pending';
      this.servers.set(def.name, { def, status, tools: [], prompts: [], resources: 0 });
    }
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Connect to all enabled servers in parallel; resolves when every attempt settled. */
  async connectAll(): Promise<void> {
    await Promise.all([...this.servers.values()].filter((s) => s.status !== 'disabled').map((s) => this.connect(s)));
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
    if (state.def.config.disabled) {
      state.status = 'disabled';
      this.changed();
      return;
    }
    const attempts: Array<'streamable' | 'sse'> = state.def.config.command || state.def.config.type === 'sse' ? ['streamable'] : ['streamable', 'sse'];
    let lastErr: unknown;
    for (const kind of attempts) {
      const client = new Client({ name: 'alteran', version: '0.1.0' }, { capabilities: CLIENT_CAPABILITIES });
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
        let count = 0;
        let cursor: string | undefined;
        do {
          const page = await client.listResources(cursor ? { cursor } : undefined);
          count += page.resources.length;
          cursor = page.nextCursor;
        } while (cursor);
        state.resources = count;
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
          return convertResult(res as { content?: unknown[]; error?: boolean; structuredContent?: unknown });
        } catch (e) {
          const msg = (e as Error).message;
          // A tool that failed because the transport died will fail again for the next one, so the
          // server is put back through a reconnect rather than left looking healthy while broken.
          if (!ctx.signal.aborted && looksDisconnected(msg)) this.disconnected(state, msg);
          return fail(`MCP ${state.def.name}.${t.name} failed: ${msg}`);
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
      let cursor: string | undefined;
      try {
        // Servers paginate resources the same way they paginate tools; stopping after the first
        // page would silently hide everything past it.
        do {
          const page = await s.client.listResources(cursor ? { cursor } : undefined);
          for (const r of page.resources) out.push({ server: s.def.name, uri: r.uri, name: r.name, mimeType: r.mimeType });
          cursor = page.nextCursor;
        } while (cursor);
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

  /**
   * A server whose transport died. It is marked as reconnecting and put back on a backoff, so a
   * server that is simply down does not turn every tool call into a fresh connection attempt.
   */
  private disconnected(state: McpServerState, reason: string) {
    const existing = this.retries.get(state.def.name);
    const attempts = (existing?.attempts ?? 0) + 1;
    if (existing) clearTimeout(existing.timer);
    state.status = 'failed';
    state.error = `connection lost: ${reason.split('\n')[0].slice(0, 200)}`;
    if (attempts > RETRY_LIMIT) {
      this.retries.delete(state.def.name);
      state.error = `${state.error} (gave up after ${RETRY_LIMIT} reconnects)`;
      this.changed();
      return;
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
    const timer = setTimeout(() => {
      void this.reconnect(state.def.name, true);
    }, delay);
    timer.unref?.();
    this.retries.set(state.def.name, { attempts, timer });
    this.changed();
  }

  async reconnect(name: string, automatic = false): Promise<void> {
    const s = this.servers.get(name);
    if (!s) throw new Error(`Unknown MCP server ${name}`);
    if (s.status === 'disabled') return;
    await s.client?.close().catch(() => {});
    s.client = undefined;
    s.status = 'pending';
    if (!automatic) {
      const pending = this.retries.get(name);
      if (pending) {
        clearTimeout(pending.timer);
        this.retries.delete(name);
      }
    }
    this.changed();
    await this.connect(s);
    // Read the status back: `connect` is what changes it, and a server that came back is healthy
    // again, so the backoff starts over next time.
    if (this.servers.get(name)?.status === 'connected') this.retries.delete(name);
  }

  async closeAll() {
    for (const { timer } of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.all([...this.servers.values()].map((s) => s.client?.close().catch(() => {})));
  }
}

/** Transport-level failures worth a reconnect; a tool that merely returned an error is not one. */
function looksDisconnected(message: string): boolean {
  return /not connected|connection closed|disconnect|ECONNRESET|EPIPE|socket hang up|transport|terminated|timed? out/i.test(message);
}

export function convertResult(res: { content?: unknown[]; isError?: boolean; structuredContent?: unknown }): ToolOutput {
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
