import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ContentBlock, Message, Provider, ProviderRequest, StopReason, StreamEvent, Usage } from '../types.js';
import { emptyUsage, textOf } from '../types.js';
import { parseToolJson } from './json.js';

export interface OpenAICompatOptions {
  id: string;
  apiKey?: string;
  baseURL: string;
  headers?: Record<string, string>;
  /** Send OpenRouter-style `reasoning: {effort}` in the body. */
  reasoningField?: 'openrouter' | 'openai' | 'none';
  /** Anthropic models behind the gateway accept cache_control on content parts. */
  anthropicCaching?: boolean;
}

function userParts(blocks: ContentBlock[]): ChatCompletionContentPart[] {
  const parts: ChatCompletionContentPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
    if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
  }
  return parts;
}

export function toChatMessages(system: string, messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use');
      const reasoning = m.content
        .filter((b) => b.type === 'thinking')
        .map((b) => (b as { text: string }).text)
        .join('');
      const msg: ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: 'assistant',
        content: text || null,
        tool_calls: calls.length
          ? calls.map((c) => {
              const tc = c as { id: string; name: string; input: unknown };
              return { id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.input) } };
            })
          : undefined,
      };
      if (reasoning) msg.reasoning_content = reasoning;
      out.push(msg);
      continue;
    }
    const results = m.content.filter((b) => b.type === 'tool_result');
    for (const r of results) {
      if (r.type !== 'tool_result') continue;
      out.push({ role: 'tool', tool_call_id: r.toolUseId, content: (r.isError ? 'ERROR: ' : '') + textOf(r.content) });
      const images = typeof r.content === 'string' ? [] : r.content.filter((c) => c.type === 'image');
      if (images.length) out.push({ role: 'user', content: userParts(images) });
    }
    const parts = userParts(m.content);
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === 'text');
      out.push({ role: 'user', content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
    }
  }
  return out;
}

const FINISH: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  private client: OpenAI;

  constructor(private opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.client = new OpenAI({
      apiKey: opts.apiKey || 'none',
      baseURL: opts.baseURL,
      defaultHeaders: opts.headers,
      maxRetries: 3,
      timeout: 15 * 60_000,
    });
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const tools: ChatCompletionTool[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const messages = toChatMessages(req.system, req.messages);
    if (this.opts.anthropicCaching && /claude|anthropic/.test(req.model)) markCache(messages);

    const body: ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
      model: req.model,
      messages,
      tools: tools.length ? tools : undefined,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
    };
    if (req.temperature != null) body.temperature = req.temperature;
    // Gateways route to the cheapest upstream by default; a pinned route must not silently fall back.
    // `only` is the whitelist (nothing outside it may serve the request), `order` the preference
    // inside it; `allow_fallbacks: false` keeps the gateway from stepping outside on an error.
    if (req.route?.length) body.provider = { only: req.route, order: req.route, allow_fallbacks: false };
    if (req.reasoning && req.reasoning !== 'off') {
      if (this.opts.reasoningField === 'openrouter') body.reasoning = { effort: req.reasoning };
      else if (this.opts.reasoningField === 'openai') body.reasoning_effort = req.reasoning;
    }

    const stream = await this.client.chat.completions.create(body, { signal: req.signal });

    let text = '';
    let reasoning = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: StopReason = 'end_turn';
    const usage: Usage = emptyUsage();

    for await (const chunk of stream) {
      if (chunk.usage) {
        const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details
          ?.cached_tokens ?? 0;
        const written = (chunk.usage as { prompt_tokens_details?: { cache_write_tokens?: number } }).prompt_tokens_details
          ?.cache_write_tokens ?? 0;
        usage.inputTokens = (chunk.usage.prompt_tokens ?? 0) - cached - written;
        usage.cacheReadTokens = cached;
        usage.cacheWriteTokens = written;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        // polza reports `cost_rub`, OpenRouter `cost` in USD credits.
        const charged = chunk.usage as { cost?: number; cost_rub?: number };
        if (charged.cost_rub != null) {
          usage.cost = charged.cost_rub;
          usage.currency = 'RUB';
        } else if (charged.cost != null) {
          usage.cost = charged.cost;
          usage.currency = 'USD';
        }
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string };
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) {
        reasoning += r;
        yield { type: 'thinking_delta', text: r };
      }
      if (delta.content) {
        text += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        let entry = calls.get(tc.index);
        if (!entry) {
          entry = { id: tc.id ?? `call_${tc.index}_${Date.now()}`, name: '', args: '' };
          calls.set(tc.index, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) {
          const started = entry.name !== '';
          entry.name += tc.function.name;
          if (!started) yield { type: 'tool_use_start', id: entry.id, name: entry.name };
        }
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
      if (choice.finish_reason) stopReason = FINISH[choice.finish_reason] ?? 'end_turn';
    }

    const content: ContentBlock[] = [];
    if (reasoning) content.push({ type: 'thinking', text: reasoning });
    if (text) content.push({ type: 'text', text });
    for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseToolJson(c.args) });
    }
    if (calls.size && stopReason === 'end_turn') stopReason = 'tool_use';
    yield { type: 'done', message: { role: 'assistant', content }, stopReason, usage };
  }
}

/** Anthropic-style cache breakpoints for gateways that forward them (OpenRouter, polza). */
function markCache(messages: ChatCompletionMessageParam[]) {
  const mark = (m: ChatCompletionMessageParam | undefined) => {
    if (!m || (m.role !== 'system' && m.role !== 'user')) return;
    if (typeof m.content === 'string') {
      (m as { content: unknown }).content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(m.content) && m.content.length) {
      const last = m.content[m.content.length - 1] as unknown as Record<string, unknown>;
      last.cache_control = { type: 'ephemeral' };
    }
  };
  mark(messages[0]);
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === 'user') {
      mark(messages[i]);
      break;
    }
  }
}
