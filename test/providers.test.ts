import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, toAnthropicParam } from '../src/providers/anthropic.js';
import { OpenAIResponsesProvider } from '../src/providers/openai-responses.js';
import { OpenAICompatProvider } from '../src/providers/openai-compat.js';
import { emptyUsage, type Message, type Provider, type ProviderRequest, type StreamEvent } from '../src/types.js';

afterEach(() => vi.unstubAllGlobals());

/** Collect a stream into an array, so a test can assert on what the provider produced. */
async function drain(provider: { stream(req: ProviderRequest): AsyncIterable<StreamEvent> }, req: ProviderRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of provider.stream(req)) out.push(ev);
  return out;
}

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'claude-sonnet-4-6',
  system: 'be helpful',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  maxTokens: 1024,
  ...over,
});

/** An SSE body as the Anthropic SDK reads it: one `data:` line per event. */
const sse = (events: unknown[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function stubSse(events: unknown[], capture?: (body: Record<string, unknown>, url: string, headers: Record<string, string>) => void) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    capture?.(JSON.parse(String(init.body)), String(url), Object.fromEntries(Object.entries(init.headers ?? {})) as Record<string, string>);
    return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

const textEvents = (text: string) => [
  { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

describe('anthropic provider', () => {
  const provider = () => new AnthropicProvider({ apiKey: 'k', baseURL: 'https://api.test' });

  it('translates an assistant turn and reports what it cost', async () => {
    stubSse(textEvents('hello there'));
    const out = await drain(provider(), request({ tools: [{ name: 'Read', description: 'reads', inputSchema: { type: 'object' } }] }));
    expect(out.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    const done = out.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    expect(done.message.content[0]).toEqual({ type: 'text', text: 'hello there' });
    expect(done.usage.inputTokens).toBe(10);
    expect(done.usage.outputTokens).toBe(5);
    // The text arrived as a delta before the final message, so the console streams as it goes.
    expect(out.some((e) => e.type === 'text_delta' && e.text === 'hello there')).toBe(true);
  });

  it('sends tools with eager input streaming and both cache breakpoints', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    const events = [
      { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu1', name: 'Read' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    stubSse(events, (b, u) => {
      body = b;
      url = u;
    });
    const out = await drain(
      provider(),
      request({
        messages: [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'prev', content: 'a hit' }] }],
        tools: [{ name: 'Read', description: 'reads', inputSchema: { type: 'object', properties: {} } }],
        cacheTtl: '1h',
      }),
    );

    expect(url).toContain('/v1/messages');
    expect(body.tools).toEqual([{ name: 'Read', description: 'reads', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true }]);
    // The system block carries the cache marker, and the top-level one follows the conversation.
    expect(JSON.stringify(body.system)).toContain('"cache_control"');
    expect(body.cache_control).toMatchObject({ type: 'ephemeral', ttl: '1h' });
    // A tool call is reassembled from its JSON deltas into one block with a parsed input.
    const done = out.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    expect(done.message.content[0]).toMatchObject({ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } });
    expect(done.stopReason).toBe('tool_use');
  });

  it('carries a thinking block and its signature through', async () => {
    stubSse([
      { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const out = await drain(provider(), request());
    expect(out.some((e) => e.type === 'thinking_delta' && e.text === 'weighing it')).toBe(true);
    const done = out.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    expect(done.message.content[0]).toMatchObject({ type: 'thinking', text: 'weighing it', signature: 'sig' });
  });

  it('maps reasoning effort onto the adaptive thinking controls', async () => {
    let body: Record<string, unknown> = {};
    stubSse(textEvents('hi'), (b) => (body = b));
    await drain(provider(), request({ model: 'claude-fable-5', reasoning: 'high' }));
    expect(body.thinking).toMatchObject({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });

    stubSse(textEvents('hi'), (b) => (body = b));
    await drain(provider(), request({ model: 'claude-fable-5', reasoning: 'off' }));
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'low' });
  });
});

describe('openai responses provider', () => {
  const provider = () => new OpenAIResponsesProvider({ id: 'openai', apiKey: 'k', baseURL: 'https://api.test/v1' });

  it('sends the conversation as input items and reads the usage back', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init.body));
      return new Response(
        [
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"hi"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":7,"output_tokens":2}}}',
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const out = await drain(provider(), request({ model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }));
    expect(url).toContain('/responses');
    expect(String(body.instructions)).toBe('be helpful');
    expect(out.some((e) => e.type === 'text_delta' && e.text === 'hi')).toBe(true);
    const done = out.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    expect(done.usage.inputTokens).toBe(7);
  });
});

describe('openai-compat tool calls', () => {
  it('synthesizes ids for a gateway that omits them', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"Read","arguments":"{\\"file_path\\":\\"a.ts\\"}"}}]},"index":0}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const provider = new OpenAICompatProvider({ id: 'polza', apiKey: 'k', baseURL: 'https://polza.ai/api/v1' });
    const out = await drain(provider, request({ model: 'deepseek/deepseek-v4.1-flash' }));
    const done = out.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    const call = done.message.content.find((b) => b.type === 'tool_use');
    // A missing id would make the tool result unaddressable, so one is invented rather than left out.
    expect(call).toMatchObject({ name: 'Read', input: { file_path: 'a.ts' } });
    expect((call as { id: string }).id).toBeTruthy();
    expect(body.messages).toBeDefined();
  });

  it('describes an image block as a data URL the gateway can read', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new OpenAICompatProvider({ id: 'polza', apiKey: 'k', baseURL: 'https://polza.ai/api/v1' });
    const messages: Message[] = [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAA' }, { type: 'text', text: 'what is this?' }] }];
    await drain(provider, request({ model: 'm', messages }));
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain('data:image/png;base64,AAA');
    expect(sent).toContain('what is this?');
  });

  it('reports an empty stream rather than resolving without a message', async () => {
    vi.stubGlobal('fetch', async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const provider = new OpenAICompatProvider({ id: 'polza', apiKey: 'k', baseURL: 'https://polza.ai/api/v1' });
    const out = await drain(provider, request({ model: 'm' }));
    expect(out.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});

describe('usage accounting', () => {
  it('starts empty so a provider that reports nothing cannot look like spend', () => {
    expect(emptyUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('document blocks', () => {
  const pdf = { type: 'document' as const, mediaType: 'application/pdf', data: 'JVBERi0=', name: 'spec.pdf' };

  it('sends a PDF to Anthropic as a document', async () => {
    let body: Record<string, unknown> = {};
    stubSse(textEvents('read it'), (b) => (body = b));
    await drain(new AnthropicProvider({ apiKey: 'k', baseURL: 'https://api.test' }), request({ messages: [{ role: 'user', content: [pdf] }] }));
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }] }]);
  });

  it('drops a media type Anthropic would reject rather than sending it', () => {
    // Nothing here is a document the API accepts, so the request carries no block at all instead
    // of one that would come back as a 400.
    expect(toAnthropicParam({ type: 'document', mediaType: 'text/plain', data: 'x' })).toBeNull();
  });

  it('tells a plain gateway it cannot take a document, instead of sending base64 as text', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new OpenAICompatProvider({ id: 'plain', apiKey: 'k', baseURL: 'https://plain.test/v1' });
    await drain(provider, request({ model: 'some/model', messages: [{ role: 'user', content: [pdf, { type: 'text', text: 'summarize' }] }] }));
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain('cannot accept documents');
    expect(sent).not.toContain('JVBERi0=');
  });

  it('sends a document to a gateway serving Anthropic-native models', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new OpenAICompatProvider({ id: 'polza', apiKey: 'k', baseURL: 'https://polza.ai/api/v1', anthropicCaching: true });
    await drain(provider, request({ model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: [pdf] }] }));
    const parts = (body.messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'document')).toBe(true);
  });

  it('carries a document to the Responses API as an input_file', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(['event: response.completed', 'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}', ''].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const provider = new OpenAIResponsesProvider({ id: 'openai', apiKey: 'k', baseURL: 'https://api.test/v1' });
    await drain(provider, request({ model: 'gpt-5', messages: [{ role: 'user', content: [pdf] }] }));
    const input = body.input as Array<{ content: Array<{ type: string; filename?: string }> }>;
    const file = input.flatMap((i) => i.content ?? []).find((c: { type: string }) => c.type === 'input_file');
    expect(file).toMatchObject({ filename: 'spec.pdf' });
  });
});

describe('exact token counting', () => {
  it('asks the provider that offers it, and counts tools with the prompt', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ input_tokens: 1234 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'https://api.test' });
    const count = await provider.countTokens!(request({ tools: [{ name: 'Read', description: 'd', inputSchema: { type: 'object' } }] }));
    expect(count).toBe(1234);
    expect(url).toContain('/v1/messages/count_tokens');
    // Tool schemas are part of the prompt, so leaving them out would undercount.
    expect(body.tools).toHaveLength(1);
    expect(body.messages).toBeDefined();
  });

  it('is absent on a gateway that has no such endpoint', () => {
    // The caller must be able to tell "no count available" from "the count is zero".
    const compat: Provider = new OpenAICompatProvider({ id: 'polza', apiKey: 'k', baseURL: 'https://polza.ai/api/v1' });
    const responses: Provider = new OpenAIResponsesProvider({ id: 'openai', apiKey: 'k', baseURL: 'https://api.test/v1' });
    expect(compat.countTokens).toBeUndefined();
    expect(responses.countTokens).toBeUndefined();
  });
});
