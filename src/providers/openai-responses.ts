import OpenAI from 'openai';
import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  FunctionTool,
} from 'openai/resources/responses/responses';
import type { ContentBlock, Message, Provider, ProviderRequest, StopReason, StreamEvent, Usage } from '../types.js';
import { emptyUsage, textOf } from '../types.js';
import { parseToolJson } from './json.js';

export interface OpenAIResponsesOptions {
  id?: string;
  apiKey?: string;
  baseURL?: string;
}

function toInput(messages: Message[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'opaque' && b.provider === 'openai') out.push(b.item as ResponseInputItem);
        else if (b.type === 'text' && b.text) {
          out.push({ role: 'assistant', content: b.text } as ResponseInputItem);
        } else if (b.type === 'tool_use') {
          out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
        }
      }
      continue;
    }
    const parts: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: b.toolUseId, output: (b.isError ? 'ERROR: ' : '') + textOf(b.content) });
        if (typeof b.content !== 'string') {
          for (const c of b.content) {
            if (c.type === 'image') parts.push({ type: 'input_image', image_url: `data:${c.mediaType};base64,${c.data}`, detail: 'auto' });
          }
        }
      } else if (b.type === 'text' && b.text) parts.push({ type: 'input_text', text: b.text });
      else if (b.type === 'image') parts.push({ type: 'input_image', image_url: `data:${b.mediaType};base64,${b.data}`, detail: 'auto' });
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

export class OpenAIResponsesProvider implements Provider {
  readonly id: string;
  private client: OpenAI;

  constructor(opts: OpenAIResponsesOptions = {}) {
    this.id = opts.id ?? 'openai';
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 3, timeout: 15 * 60_000 });
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const tools: FunctionTool[] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
    const reasoningModel = /^(o\d|gpt-5|codex)/.test(req.model);
    const params: ResponseCreateParamsStreaming = {
      model: req.model,
      instructions: req.system,
      input: toInput(req.messages),
      tools: tools.length ? tools : undefined,
      max_output_tokens: req.maxTokens,
      store: false,
      stream: true,
    };
    // OpenAI caches prefixes automatically; the key only steers requests that share one onto the
    // same cache shard, which matters once several agents run against the same account.
    if (req.cacheKey) params.prompt_cache_key = req.cacheKey;
    if (reasoningModel) {
      params.reasoning = {
        effort: req.reasoning === 'off' ? 'minimal' : (req.reasoning ?? 'medium'),
        summary: 'auto',
      };
      params.include = ['reasoning.encrypted_content'];
    }

    const stream = await this.client.responses.create(params, { signal: req.signal });

    const content: ContentBlock[] = [];
    const usage: Usage = emptyUsage();
    let stopReason: StopReason = 'end_turn';
    let text = '';

    for await (const ev of stream) {
      switch (ev.type) {
        case 'response.output_text.delta':
          text += ev.delta;
          yield { type: 'text_delta', text: ev.delta };
          break;
        case 'response.reasoning_summary_text.delta':
          yield { type: 'thinking_delta', text: ev.delta };
          break;
        case 'response.output_item.added':
          if (ev.item.type === 'function_call') yield { type: 'tool_use_start', id: ev.item.call_id, name: ev.item.name };
          break;
        case 'response.output_item.done': {
          const item = ev.item;
          if (item.type === 'reasoning') {
            const summary = (item.summary ?? []).map((s) => s.text).join('\n');
            if (summary) content.push({ type: 'thinking', text: summary });
            content.push({ type: 'opaque', provider: 'openai', item });
          } else if (item.type === 'message') {
            const t = item.content.map((c) => (c.type === 'output_text' ? c.text : '')).join('');
            if (t) content.push({ type: 'text', text: t });
          } else if (item.type === 'function_call') {
            content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parseToolJson(item.arguments) });
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const u = ev.response.usage;
          if (u) {
            const cached = u.input_tokens_details?.cached_tokens ?? 0;
            usage.inputTokens = u.input_tokens - cached;
            usage.cacheReadTokens = cached;
            usage.outputTokens = u.output_tokens;
          }
          if (ev.type === 'response.incomplete') stopReason = 'max_tokens';
          break;
        }
        case 'response.failed':
          throw new Error(ev.response.error?.message ?? 'OpenAI response failed');
        default:
          break;
      }
    }
    if (!content.some((b) => b.type === 'text') && text) content.push({ type: 'text', text });
    if (content.some((b) => b.type === 'tool_use')) stopReason = 'tool_use';
    yield { type: 'done', message: { role: 'assistant', content }, stopReason, usage };
  }
}
