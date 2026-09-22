export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string;
  data: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  signature?: string;
  redacted?: string;
}

/** Provider-specific item that must be echoed back verbatim (e.g. OpenAI reasoning items). */
export interface OpaqueBlock {
  type: 'opaque';
  provider: string;
  item: unknown;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolResultContent = string | Array<TextBlock | ImageBlock>;

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: ToolResultContent;
  isError?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | OpaqueBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Charged amount, when the gateway reports one (polza/OpenRouter). */
  cost?: number;
  /** Currency of `cost` (polza bills in RUB). */
  currency?: string;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  const cost = (a.cost ?? 0) + (b.cost ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: cost || undefined,
    currency: b.currency ?? a.currency,
  };
}

/** Total prompt size of a request, including cached parts. */
export const promptTokens = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'error' | 'aborted';

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'done'; message: Message; stopReason: StopReason; usage: Usage };

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
  /** Thinking / reasoning budget; provider decides how to map it. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  temperature?: number;
  /** Upstream providers to route to, best first (polza/OpenRouter gateways). */
  route?: string[];
}

export interface Provider {
  readonly id: string;
  stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
}

export function textOf(content: ContentBlock[] | ToolResultContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}
