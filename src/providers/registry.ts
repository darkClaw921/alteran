import type { Provider } from '../types.js';
import type { ProviderConfig, Settings } from '../config/settings.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5' },
  openai: { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-5.1-codex' },
  openrouter: {
    type: 'openai-compat',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    reasoningField: 'openrouter',
    anthropicCaching: true,
    headers: { 'HTTP-Referer': 'https://github.com/alteran', 'X-Title': 'Alteran' },
    defaultModel: 'anthropic/claude-opus-5',
  },
  polza: {
    type: 'openai-compat',
    baseURL: 'https://polza.ai/api/v1',
    apiKeyEnv: 'POLZA_API_KEY',
    reasoningField: 'openrouter',
    anthropicCaching: true,
    defaultModel: 'anthropic/claude-sonnet-4.6',
  },
  /** polza.ai through its Anthropic-compatible endpoint (native thinking + caching). */
  'polza-anthropic': {
    type: 'anthropic',
    baseURL: 'https://polza.ai/api',
    apiKeyEnv: 'POLZA_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4.6',
  },
  ollama: { type: 'openai-compat', baseURL: 'http://localhost:11434/v1', reasoningField: 'none', defaultModel: 'qwen3-coder' },
  lmstudio: { type: 'openai-compat', baseURL: 'http://localhost:1234/v1', reasoningField: 'none', defaultModel: 'local-model' },
};

export interface ModelRef {
  provider: string;
  model: string;
  /** "provider:model" */
  id: string;
}

export interface ModelInfo {
  contextWindow: number;
  maxOutput: number;
}

const KNOWN: Array<[RegExp, ModelInfo]> = [
  [/haiku-4|claude-3/, { contextWindow: 200_000, maxOutput: 64_000 }],
  [/claude-(fable|mythos|opus|sonnet)-(5|4[.-][6-9])/, { contextWindow: 1_000_000, maxOutput: 128_000 }],
  [/claude/, { contextWindow: 200_000, maxOutput: 64_000 }],
  [/gpt-5|codex/, { contextWindow: 400_000, maxOutput: 128_000 }],
  [/gpt-4\.1/, { contextWindow: 1_000_000, maxOutput: 32_000 }],
  [/o[34]/, { contextWindow: 200_000, maxOutput: 100_000 }],
  [/gemini-(2\.5|3)/, { contextWindow: 1_000_000, maxOutput: 64_000 }],
  [/deepseek-v4|deepseek-v4\.1/, { contextWindow: 1_000_000, maxOutput: 64_000 }],
  [/deepseek/, { contextWindow: 128_000, maxOutput: 32_000 }],
  [/qwen3|kimi|glm/, { contextWindow: 256_000, maxOutput: 32_000 }],
];

export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  readonly configs: Record<string, ProviderConfig>;

  constructor(private settings: Settings) {
    this.configs = { ...BUILTIN_PROVIDERS };
    for (const [id, cfg] of Object.entries(settings.providers ?? {})) {
      this.configs[id] = { ...this.configs[id], ...cfg };
    }
  }

  apiKey(providerId: string): string | undefined {
    const cfg = this.configs[providerId];
    if (!cfg) return undefined;
    return cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
  }

  /** Providers usable right now (key present, or local server). */
  available(): string[] {
    return Object.keys(this.configs).filter((id) => {
      const cfg = this.configs[id];
      if (!cfg.apiKeyEnv && !cfg.apiKey) return false;
      return Boolean(this.apiKey(id));
    });
  }

  resolve(spec?: string): ModelRef {
    const aliases = this.settings.modelAliases ?? {};
    let s = spec ?? this.settings.model ?? '';
    if (aliases[s]) s = aliases[s];
    if (!s) {
      const order = ['anthropic', 'polza', 'openrouter', 'openai'];
      const provider = order.find((p) => this.available().includes(p)) ?? 'anthropic';
      const model = this.configs[provider].defaultModel!;
      return { provider, model, id: `${provider}:${model}` };
    }
    const colon = s.indexOf(':');
    if (colon > 0 && this.configs[s.slice(0, colon)]) {
      const provider = s.slice(0, colon);
      const model = s.slice(colon + 1) || this.configs[provider].defaultModel || '';
      return { provider, model, id: `${provider}:${model}` };
    }
    if (this.configs[s]) {
      const model = this.configs[s].defaultModel ?? '';
      return { provider: s, model, id: `${s}:${model}` };
    }
    const provider = guessProvider(s, this.available());
    return { provider, model: s, id: `${provider}:${s}` };
  }

  /** Map Claude-style agent model names (opus/sonnet/haiku/inherit) onto the active provider. */
  resolveAgentModel(name: string | undefined, parent: ModelRef): ModelRef {
    if (!name || name === 'inherit') return parent;
    const aliases = this.settings.modelAliases ?? {};
    if (aliases[name]) return this.resolve(aliases[name]);
    const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => name === f);
    if (!family) return this.resolve(name);
    if (family === 'haiku' && this.settings.smallModel) return this.resolve(this.settings.smallModel);
    const ids: Record<string, string> = {
      opus: 'claude-opus-5',
      sonnet: 'claude-sonnet-5',
      haiku: 'claude-haiku-4-5',
      fable: 'claude-fable-5-1',
    };
    if (parent.provider === 'anthropic') return { provider: 'anthropic', model: ids[family], id: `anthropic:${ids[family]}` };
    return parent;
  }

  /** Upstream providers pinned for this model, best first. */
  route(ref: ModelRef): string[] | undefined {
    const r = this.settings.routes?.[ref.id];
    return r?.length ? r : undefined;
  }

  /** Pin (or, with an empty list, unpin) the upstream providers for a model. */
  setRoute(ref: ModelRef, order: string[]) {
    const routes = { ...(this.settings.routes ?? {}) };
    if (order.length) routes[ref.id] = order;
    else delete routes[ref.id];
    this.settings.routes = routes;
  }

  info(ref: ModelRef): ModelInfo {
    const custom = this.configs[ref.provider]?.models?.[ref.model];
    const known = KNOWN.find(([re]) => re.test(ref.model))?.[1] ?? { contextWindow: 200_000, maxOutput: 32_000 };
    return {
      contextWindow: custom?.contextWindow ?? known.contextWindow,
      maxOutput: custom?.maxOutput ?? known.maxOutput,
    };
  }

  get(providerId: string): Provider {
    const cached = this.cache.get(providerId);
    if (cached) return cached;
    const cfg = this.configs[providerId];
    if (!cfg) throw new Error(`Unknown provider "${providerId}". Known: ${Object.keys(this.configs).join(', ')}`);
    const apiKey = this.apiKey(providerId);
    if (cfg.apiKeyEnv && !apiKey && !cfg.baseURL?.includes('localhost')) {
      throw new Error(`Provider "${providerId}" needs an API key: set ${cfg.apiKeyEnv} or providers.${providerId}.apiKey`);
    }
    let provider: Provider;
    if (cfg.type === 'anthropic') provider = new AnthropicProvider({ apiKey, baseURL: cfg.baseURL });
    else if (cfg.type === 'openai') provider = new OpenAIResponsesProvider({ id: providerId, apiKey, baseURL: cfg.baseURL });
    else
      provider = new OpenAICompatProvider({
        id: providerId,
        apiKey,
        baseURL: cfg.baseURL ?? '',
        headers: cfg.headers,
        reasoningField: cfg.reasoningField,
        anthropicCaching: cfg.anthropicCaching,
      });
    this.cache.set(providerId, provider);
    return provider;
  }
}

function guessProvider(model: string, available: string[]): string {
  const pick = (...ids: string[]) => ids.find((id) => available.includes(id));
  if (/^claude-/.test(model)) return pick('anthropic', 'polza-anthropic') ?? 'anthropic';
  if (/^(gpt-|o\d|codex)/.test(model)) return pick('openai') ?? 'openai';
  if (model.includes('/')) return pick('polza', 'openrouter') ?? 'openrouter';
  return pick('ollama') ?? 'ollama';
}
