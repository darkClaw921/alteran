import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message, Provider, ProviderRequest, StopReason, StreamEvent, ToolResultBlock, Usage } from '../types.js';
import { emptyUsage } from '../types.js';
import { parseToolJson } from './json.js';

export interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
}

/** Models on the 4.6+ / 5 surface: adaptive thinking + effort, no budget_tokens. */
function supportsAdaptive(model: string): boolean {
  return !/haiku|claude-3|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|claude-(opus|sonnet)-4$/.test(model);
}

function toParam(block: ContentBlock): Anthropic.ContentBlockParam | null {
  switch (block.type) {
    case 'text':
      return block.text ? { type: 'text', text: block.text } : null;
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType as 'image/png', data: block.data },
      };
    case 'thinking':
      if (block.redacted) return { type: 'redacted_thinking', data: block.redacted };
      if (!block.signature) return null;
      return { type: 'thinking', thinking: block.text, signature: block.signature };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return toolResultParam(block);
    case 'opaque':
      return null;
  }
}

function toolResultParam(block: ToolResultBlock): Anthropic.ToolResultBlockParam {
  const content =
    typeof block.content === 'string'
      ? block.content
      : block.content.map((c) =>
          c.type === 'text'
            ? ({ type: 'text', text: c.text } as const)
            : ({
                type: 'image',
                source: { type: 'base64', media_type: c.mediaType as 'image/png', data: c.data },
              } as const),
        );
  return { type: 'tool_result', tool_use_id: block.toolUseId, content, is_error: block.isError || undefined };
}

function toMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const content = m.content.map(toParam).filter((b): b is Anthropic.ContentBlockParam => b !== null);
    if (content.length === 0) continue;
    out.push({ role: m.role, content });
  }
  return out;
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
  pause_turn: 'end_turn',
};

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  private client: Anthropic;

  constructor(opts: AnthropicOptions = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 3, timeout: 15 * 60_000 });
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const adaptive = supportsAdaptive(req.model);
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    }));
    // Tools render before system, so the marker on the system block caches tools and system
    // together; the top-level field then follows the growing conversation on its own. Both carry
    // the same TTL — a longer entry may precede a shorter one, never the other way round.
    const cache = { type: 'ephemeral', ...(req.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) } as const;
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: cache }],
      messages: toMessages(req.messages),
      tools: tools.length ? tools : undefined,
      cache_control: cache,
      stream: true,
    };
    if (adaptive) {
      if (req.reasoning === 'off') {
        params.output_config = { effort: 'low' };
      } else {
        params.thinking = { type: 'adaptive', display: 'summarized' };
        params.output_config = { effort: req.reasoning === 'low' ? 'low' : req.reasoning === 'medium' ? 'medium' : 'high' };
      }
    } else if (req.reasoning && req.reasoning !== 'off' && req.maxTokens > 4096) {
      const budget = req.reasoning === 'low' ? 2048 : req.reasoning === 'medium' ? 8000 : 16000;
      params.thinking = { type: 'enabled', budget_tokens: Math.min(budget, req.maxTokens - 1024) };
    }

    const stream = await this.client.messages.create(params, { signal: req.signal });

    const blocks: Array<ContentBlock & { _json?: string }> = [];
    const usage: Usage = emptyUsage();
    let stopReason: StopReason = 'end_turn';

    for await (const ev of stream) {
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message.usage;
          usage.inputTokens = u.input_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block;
          if (cb.type === 'text') blocks[ev.index] = { type: 'text', text: '' };
          else if (cb.type === 'thinking') blocks[ev.index] = { type: 'thinking', text: '', signature: '' };
          else if (cb.type === 'redacted_thinking') blocks[ev.index] = { type: 'thinking', text: '', redacted: cb.data };
          else if (cb.type === 'tool_use') {
            blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' };
            yield { type: 'tool_use_start', id: cb.id, name: cb.name };
          }
          break;
        }
        case 'content_block_delta': {
          const b = blocks[ev.index];
          const d = ev.delta;
          if (!b) break;
          if (d.type === 'text_delta' && b.type === 'text') {
            b.text += d.text;
            yield { type: 'text_delta', text: d.text };
          } else if (d.type === 'thinking_delta' && b.type === 'thinking') {
            b.text += d.thinking;
            yield { type: 'thinking_delta', text: d.thinking };
          } else if (d.type === 'signature_delta' && b.type === 'thinking') {
            b.signature = (b.signature ?? '') + d.signature;
          } else if (d.type === 'input_json_delta') {
            b._json = (b._json ?? '') + d.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks[ev.index];
          if (b?.type === 'tool_use') {
            b.input = parseToolJson(b._json ?? '');
            delete b._json;
          }
          break;
        }
        case 'message_delta': {
          if (ev.delta.stop_reason) stopReason = STOP[ev.delta.stop_reason] ?? 'end_turn';
          if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens;
          break;
        }
        default:
          break;
      }
    }

    const content = blocks.filter(Boolean) as ContentBlock[];
    yield { type: 'done', message: { role: 'assistant', content }, stopReason, usage };
  }
}
