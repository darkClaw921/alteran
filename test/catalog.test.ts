import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalog, filterModels, fmtContext, fmtMoney, fmtPrice } from '../src/providers/catalog.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { OpenAICompatProvider } from '../src/providers/openai-compat.js';

let home: string;

const POLZA_MODELS = {
  object: 'list',
  data: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek: V4.1 Flash',
      architecture: { modality: 'text->text' },
      top_provider: {
        name: 'deepinfra/fp8',
        context_length: 1_048_576,
        max_completion_tokens: 65_536,
        pricing: { prompt_per_million: '13.21510400', completion_per_million: '39.64531200', input_cache_read_per_million: '1.32151040', currency: 'RUB' },
        supported_parameters: ['reasoning', 'tools'],
      },
    },
    { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', top_provider: { context_length: 1_000_000 } },
  ],
};

const POLZA_MODEL = {
  id: 'deepseek/deepseek-v4.1-flash',
  providers: [
    { name: 'deepseek', context_length: 1_048_576, pricing: { prompt_per_million: '17.69880000', completion_per_million: '70.79520000', currency: 'RUB' } },
    { name: 'cloud-ru', context_length: 1_048_576, stores_data_in_russia: true, pricing: { prompt_per_million: '90.91600000', completion_per_million: '272.73400000', currency: 'RUB' } },
  ],
};

/** OpenRouter prices per token, in USD, and nests endpoints under `data`. */
const OPENROUTER_MODELS = {
  data: [{ id: 'anthropic/claude-opus-5', context_length: 1_000_000, pricing: { prompt: '0.000005', completion: '0.000025' } }],
};

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const key = String(url);
    const body = Object.entries(routes).find(([k]) => key.endsWith(k))?.[1];
    if (!body) return new Response('{"error":{"message":"not found"}}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-catalog-'));
  process.env.ALTERAN_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ALTERAN_HOME;
  vi.unstubAllGlobals();
});

describe('model catalog', () => {
  const registry = () => new ProviderRegistry({ providers: { polza: { type: 'openai-compat', apiKey: 'k' }, openrouter: { type: 'openai-compat', apiKey: 'k' } } } as never);

  it('parses polza models with per-million RUB pricing', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/models': POLZA_MODELS }));
    const models = await new ModelCatalog(registry()).models('polza');
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'deepseek/deepseek-v4.1-flash', contextWindow: 1_048_576, maxOutput: 65_536, topProvider: 'deepinfra/fp8' });
    expect(models[0].pricing).toMatchObject({ in: 13.215104, out: 39.645312, currency: 'RUB' });
    expect(fmtPrice(models[0].pricing)).toBe('13.22₽ / 39.65₽ per 1M');
    // A model without pricing must not invent one.
    expect(models[1].pricing).toBeUndefined();
  });

  it('converts OpenRouter per-token USD pricing to per-million', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/models': OPENROUTER_MODELS }));
    const [model] = await new ModelCatalog(registry()).models('openrouter');
    expect(model.pricing).toMatchObject({ in: 5, out: 25, currency: 'USD' });
    expect(fmtPrice(model.pricing)).toBe('$5.00 / $25.00 per 1M');
  });

  it('lists the upstream providers of a model with their prices', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/models/deepseek/deepseek-v4.1-flash': POLZA_MODEL }));
    const routes = await new ModelCatalog(registry()).routes('polza', 'deepseek/deepseek-v4.1-flash');
    expect(routes.map((r) => r.name)).toEqual(['deepseek', 'cloud-ru']);
    expect(routes[1]).toMatchObject({ ru: true });
    expect(routes[0].pricing?.in).toBeCloseTo(17.6988);
  });

  it('reports key limits and balance', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/key': { limit: 200, limit_remaining: 199.09, usage: 0.9, limit_reset: 'weekly' }, '/balance': { available: '199.09', amount: '599.14' } }));
    const status = await new ModelCatalog(registry()).key('polza');
    expect(status).toMatchObject({ limit: 200, remaining: 199.09, used: 0.9, balance: 199.09, currency: 'RUB' });
  });

  it('serves the second call from the disk cache', async () => {
    const fetchMock = stubFetch({ '/models': POLZA_MODELS });
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ModelCatalog(registry());
    await catalog.models('polza');
    await catalog.models('polza');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await catalog.models('polza', true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('filters by id and display name', () => {
    const models = [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash' },
      { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5' },
    ];
    expect(filterModels(models, 'deep flash').map((m) => m.id)).toEqual(['deepseek/deepseek-v4.1-flash']);
    expect(filterModels(models, 'opus')).toHaveLength(1);
    expect(filterModels(models, '')).toHaveLength(2);
  });

  it('formats context windows and money compactly', () => {
    expect(fmtContext(1_048_576)).toBe('1.0M');
    expect(fmtContext(200_000)).toBe('200k');
    expect(fmtContext(undefined)).toBe('—');
    expect(fmtMoney(0.0016, 'RUB')).toBe('0.0016₽');
    expect(fmtMoney(3, 'USD')).toBe('$3.00');
  });
});

describe('provider routing', () => {
  it('pins upstream providers per model', () => {
    const reg = new ProviderRegistry({ providers: { polza: { type: 'openai-compat', apiKey: 'k' } } } as never);
    const ref = reg.resolve('polza:deepseek/deepseek-v4.1-flash');
    expect(reg.route(ref)).toBeUndefined();
    reg.setRoute(ref, ['morph/fp8']);
    expect(reg.route(ref)).toEqual(['morph/fp8']);
    // Another model keeps automatic routing.
    expect(reg.route(reg.resolve('polza:anthropic/claude-opus-5'))).toBeUndefined();
    reg.setRoute(ref, []);
    expect(reg.route(ref)).toBeUndefined();
  });

  it('sends a pinned route as a whitelist without fallbacks and reads back the charged cost', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const chunks = [
        'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":31,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":10},"cost_rub":0.00134511}}\n\n',
        'data: [DONE]\n\n',
      ];
      return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new OpenAICompatProvider({ id: 'polza', apiKey: 'k', baseURL: 'https://polza.ai/api/v1' });
    let usage;
    for await (const ev of provider.stream({ model: 'm', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 16, route: ['morph/fp8'] })) {
      if (ev.type === 'done') usage = ev.usage;
    }
    // `only` is what actually forbids another upstream; `order` only ranks the allowed ones.
    expect(body?.provider).toEqual({ only: ['morph/fp8'], order: ['morph/fp8'], allow_fallbacks: false });
    expect(usage).toMatchObject({ inputTokens: 21, cacheReadTokens: 10, outputTokens: 8, cost: 0.00134511, currency: 'RUB' });
  });
});
