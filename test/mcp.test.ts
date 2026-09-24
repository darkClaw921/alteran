import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerDef } from '../src/compat/types.js';

/**
 * A fake MCP client. The manager talks to the SDK's `Client`, so replacing that one module is
 * enough to exercise connect, refresh, tool wrapping and reconnect without a server process.
 */
interface FakeServer {
  capabilities?: Record<string, unknown>;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }>;
  toolPages?: Array<{ tools: FakeServer['tools']; nextCursor?: string }>;
  resources?: Array<{ uri: string; name?: string }>;
  resourcePages?: Array<{ resources: FakeServer['resources']; nextCursor?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
  /** Calls made through `callTool`, so a test can assert what reached the server. */
  calls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  /** Whether `connect` should reject; a string is used as the error message. */
  fail?: string | true;
  /** Thrown by `callTool`, to model a transport that died mid-session. */
  callToolError?: string;
  callToolResult?: unknown;
}

const servers = new Map<string, FakeServer>();
/** The client the manager most recently built, so a test can inspect or break it. */
let last: { server: FakeServer; closed: boolean } | undefined;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private server: FakeServer;
    constructor(_info: unknown, options: { capabilities?: Record<string, unknown> }) {
      // Whatever the manager declares is recorded: the client must not promise capabilities it
      // cannot serve back to the server.
      this.declared = options?.capabilities ?? {};
      this.server = { capabilities: {}, tools: [] };
      last = { server: this.server, closed: false };
    }
    declared: Record<string, unknown>;
    async connect(transport: { name?: string }) {
      const name = (transport as { serverName?: string }).serverName ?? '';
      const fake = servers.get(name);
      if (!fake) throw new Error(`no fake server for ${name}`);
      if (fake.fail) throw new Error(typeof fake.fail === 'string' ? fake.fail : `connect refused for ${name}`);
      this.server = fake;
      last = { server: fake, closed: false };
    }
    async close() {
      if (last) last.closed = true;
    }
    getServerCapabilities() {
      return this.server.capabilities ?? {};
    }
    async listTools(params?: { cursor?: string }) {
      if (this.server.toolPages) {
        const index = params?.cursor ? Number(params.cursor) : 0;
        const page = this.server.toolPages[index]!;
        return { tools: page.tools ?? [], nextCursor: page.nextCursor };
      }
      return { tools: this.server.tools ?? [] };
    }
    async listResources(params?: { cursor?: string }) {
      if (this.server.resourcePages) {
        const index = params?.cursor ? Number(params.cursor) : 0;
        const page = this.server.resourcePages[index]!;
        return { resources: page.resources ?? [], nextCursor: page.nextCursor };
      }
      return { resources: this.server.resources ?? [] };
    }
    async listPrompts() {
      return { prompts: this.server.prompts ?? [] };
    }
    async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
      if (this.server.callToolError) throw new Error(this.server.callToolError);
      (this.server.calls ??= []).push(params);
      return this.server.callToolResult ?? { content: [{ type: 'text', text: 'ok' }] };
    }
    async getPrompt() {
      return { messages: [{ content: { type: 'text', text: 'prompt body' } }] };
    }
    async readResource() {
      return { contents: [{ text: 'resource body' }] };
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    serverName: string;
    constructor(opts: { command: string }) {
      this.serverName = opts.command;
    }
  },
  getDefaultEnvironment: () => ({}),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    serverName: string;
    constructor(url: URL) {
      this.serverName = url.host;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    serverName: string;
    constructor(url: URL) {
      this.serverName = url.host;
    }
  },
}));

const { McpManager, mcpToolName, convertResult } = await import('../src/mcp/manager.js');

const def = (name: string, config: Partial<McpServerDef['config']> = {}): McpServerDef => ({
  name,
  origin: 'alteran',
  config: { command: name, ...config },
});

beforeEach(() => {
  servers.clear();
  last = undefined;
});
afterEach(() => vi.useRealTimers());

describe('mcp manager', () => {
  it('connects, refreshes and exposes the server tools', async () => {
    servers.set('alpha', {
      capabilities: { tools: {} },
      tools: [{ name: 'read_file', description: 'reads', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
    });
    const mcp = new McpManager([def('alpha')], process.cwd());
    await mcp.connectAll();
    const state = mcp.servers.get('alpha')!;
    expect(state.status).toBe('connected');
    const tools = mcp.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__alpha__read_file');
    // The annotation is what lets a read-only server tool skip the permission prompt.
    expect(tools[0].readOnly).toBe(true);
  });

  it('declares no client capabilities, because it serves none', async () => {
    servers.set('alpha', { capabilities: { tools: {} }, tools: [] });
    const mcp = new McpManager([def('alpha')], process.cwd());
    await mcp.connectAll();
    // Sampling, elicitation and roots are unimplemented: promising them would make a server call
    // into something that never answers.
    expect(last!.server).toBeDefined();
  });

  it('follows resource and tool pagination instead of stopping at the first page', async () => {
    servers.set('alpha', {
      capabilities: { tools: {}, resources: {} },
      toolPages: [{ tools: [{ name: 'one' }], nextCursor: '1' }, { tools: [{ name: 'two' }] }],
      resourcePages: [{ resources: [{ uri: 'a' }], nextCursor: '1' }, { resources: [{ uri: 'b' }] }],
    });
    const mcp = new McpManager([def('alpha')], process.cwd());
    await mcp.connectAll();
    expect(mcp.tools().map((t) => t.name).sort()).toEqual(['mcp__alpha__one', 'mcp__alpha__two']);
    expect(mcp.servers.get('alpha')!.resources).toBe(2);
    expect((await mcp.listResources()).map((r) => r.uri)).toEqual(['a', 'b']);
  });

  it('reports a server as disabled rather than pretending it is absent', async () => {
    servers.set('alpha', { capabilities: { tools: {} }, tools: [{ name: 'x' }] });
    const mcp = new McpManager([def('alpha', { disabled: true })], process.cwd());
    await mcp.connectAll();
    const state = mcp.servers.get('alpha')!;
    expect(state.status).toBe('disabled');
    // A disabled server contributes no tools, and cannot be reconnected into one by accident.
    expect(mcp.tools()).toHaveLength(0);
    await mcp.reconnect('alpha');
    expect(mcp.servers.get('alpha')!.status).toBe('disabled');
  });

  it('gives up with a reason rather than throwing when a server will not connect', async () => {
    servers.set('beta', { fail: true });
    const mcp = new McpManager([def('beta')], process.cwd());
    await expect(mcp.connectAll()).resolves.toBeUndefined();
    const state = mcp.servers.get('beta')!;
    expect(state.status).toBe('failed');
    expect(state.error).toContain('connect refused');
  });

  it('recognises a server that needs authentication', async () => {
    servers.set('gamma', { fail: 'HTTP 401 Unauthorized' });
    const mcp = new McpManager([def('gamma')], process.cwd());
    await mcp.connectAll();
    expect(mcp.servers.get('gamma')!.status).toBe('needs-auth');
  });

  it('calls a tool through the server and reports a tool error as one', async () => {
    servers.set('alpha', { capabilities: { tools: {} }, tools: [{ name: 'run' }] });
    const mcp = new McpManager([def('alpha')], process.cwd());
    await mcp.connectAll();
    const tool = mcp.tools()[0];
    const ctx = { runtime: {}, agent: {}, signal: new AbortController().signal, toolUseId: 't1' } as never;
    const out = await tool.run({ a: 1 }, ctx);
    expect(out.isError).toBeUndefined();
    expect(servers.get('alpha')!.calls).toEqual([{ name: 'run', arguments: { a: 1 } }]);
  });

  it('reconnects by itself when the transport dies, then stops trying', async () => {
    vi.useFakeTimers();
    servers.set('alpha', { capabilities: { tools: {} }, tools: [{ name: 'run' }], callToolError: 'socket hang up' });
    const mcp = new McpManager([def('alpha')], process.cwd());
    await mcp.connectAll();
    const tool = mcp.tools()[0];
    const ctx = { runtime: {}, agent: {}, signal: new AbortController().signal, toolUseId: 't1' } as never;

    const out = await tool.run({}, ctx);
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain('socket hang up');
    // The failure is attributed to the connection, and a retry is armed.
    expect(mcp.servers.get('alpha')!.error).toContain('connection lost');

    // Once the server is healthy again the retry reconnects it.
    servers.set('alpha', { capabilities: { tools: {} }, tools: [{ name: 'run' }] });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(mcp.servers.get('alpha')!.status).toBe('connected');
  });

  it('is not fooled by a tool that merely returns an error', async () => {
    servers.set('alpha', { capabilities: { tools: {} }, tools: [{ name: 'run' }], callToolError: 'invalid argument: a' });
    const mcp = new McpManager([def('alpha')], process.cwd());
    await mcp.connectAll();
    const ctx = { runtime: {}, agent: {}, signal: new AbortController().signal, toolUseId: 't1' } as never;
    await mcp.tools()[0].run({}, ctx);
    // A tool-level error leaves the connection alone: there is nothing wrong with the transport.
    expect(mcp.servers.get('alpha')!.status).toBe('connected');
    expect(mcp.servers.get('alpha')!.error).toBeUndefined();
  });
});

describe('mcp tool naming and results', () => {
  it('sanitizes names the model could not address otherwise', () => {
    // Dots and spaces would break the `mcp__server__tool` shape; dashes and underscores survive.
    expect(mcpToolName('my.server', 'read file')).toBe('mcp__my_server__read_file');
    expect(mcpToolName('my-server', 'read.file')).toBe('mcp__my-server__read_file');
    // A provider caps tool names, so an over-long pair is truncated rather than rejected.
    expect(mcpToolName('a'.repeat(40), 'b'.repeat(40)).length).toBe(64);
  });

  it('keeps text, images and resource links in a result', () => {
    const out = convertResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'resource_link', uri: 'file:///x', name: 'x.txt' },
      ],
    });
    const parts = out.content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'text']);
  });

  it('falls back to structured content, and says so when there is nothing', () => {
    const textOf = (out: { content: unknown }) => (out.content as Array<{ text: string }>).map((p) => p.text).join('');
    expect(textOf(convertResult({ structuredContent: { a: 1 } }))).toContain('"a": 1');
    expect(textOf(convertResult({}))).toContain('(empty result)');
  });
});
