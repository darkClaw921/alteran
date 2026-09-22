/**
 * Model catalogs: what a provider offers, at what price, through which upstream.
 *
 * Gateways (polza.ai, OpenRouter) expose per-model pricing and a list of upstream providers,
 * so `/model` can show cost and let the user pin a route. Direct APIs (Anthropic, OpenAI)
 * only list model ids. Results are cached on disk because the polza catalog is ~500KB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { alteranHome } from '../config/paths.js';
import type { ProviderRegistry } from './registry.js';

export interface Pricing {
  /** Per million tokens. */
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheWrite?: number;
  currency: string;
}

/** One upstream provider serving a model (polza/OpenRouter routing target). */
export interface ModelRoute {
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: Pricing;
  params?: string[];
  moderated?: boolean;
  /** Data stays in Russia / 152-ФЗ compliant (polza flags). */
  ru?: boolean;
  fz152?: boolean;
}

export interface CatalogModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: Pricing;
  modality?: string;
  params?: string[];
  topProvider?: string;
  created?: number;
}

export interface KeyStatus {
  /** Spend limit for the key, in the provider's currency. */
  limit?: number;
  remaining?: number;
  used?: number;
  /** Account balance, when the provider reports one separately. */
  balance?: number;
  reset?: string;
  currency: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const KEY_TTL_MS = 60 * 1000;

function cacheFile(name: string): string {
  return path.join(alteranHome(), 'cache', `${name.replace(/[^\w.-]/g, '_')}.json`);
}

function readCache<T>(name: string, ttl = TTL_MS): T | undefined {
  try {
    const file = cacheFile(name);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttl) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeCache(name: string, data: unknown) {
  try {
    const file = cacheFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    /* cache is best-effort */
  }
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 30_000): Promise<unknown> {
  // The first TLS handshake to a gateway is often slow, and a cold DNS lookup can fail outright,
  // so one retry keeps the balance line from silently disappearing.
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body;
    } catch (e) {
      lastError = e as Error;
      if (process.env.ALTERAN_DEBUG) process.stderr.write(`catalog: ${url} — ${lastError.message}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`Request to ${url} failed`);
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pricing comes in two shapes: polza's `*_per_million` (RUB strings) and
 * OpenRouter's per-token `prompt`/`completion` (USD strings).
 */
function parsePricing(p: unknown): Pricing | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const r = p as Record<string, unknown>;
  if (r.prompt_per_million != null || r.completion_per_million != null) {
    return {
      in: num(r.prompt_per_million),
      out: num(r.completion_per_million),
      cacheRead: num(r.input_cache_read_per_million),
      cacheWrite: num(r.input_cache_write_per_million),
      currency: typeof r.currency === 'string' ? r.currency : 'RUB',
    };
  }
  const perToken = (v: unknown) => {
    const n = num(v);
    return n == null ? undefined : n * 1_000_000;
  };
  const priced = { in: perToken(r.prompt), out: perToken(r.completion), cacheRead: perToken(r.input_cache_read), cacheWrite: perToken(r.input_cache_write) };
  if (priced.in == null && priced.out == null) return undefined;
  return { ...priced, currency: 'USD' };
}

function parseRoute(p: unknown): ModelRoute | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const r = p as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : typeof r.provider_name === 'string' ? r.provider_name : undefined;
  if (!name) return undefined;
  return {
    name,
    contextWindow: num(r.context_length),
    maxOutput: num(r.max_completion_tokens),
    pricing: parsePricing(r.pricing),
    params: Array.isArray(r.supported_parameters) ? (r.supported_parameters as string[]) : undefined,
    moderated: r.is_moderated === true,
    ru: r.stores_data_in_russia === true,
    fz152: r.is_fz152_compliant === true,
  };
}

function parseModel(m: unknown): CatalogModel | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const r = m as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : undefined;
  if (!id) return undefined;
  const top = (r.top_provider ?? {}) as Record<string, unknown>;
  const arch = (r.architecture ?? {}) as Record<string, unknown>;
  return {
    id,
    name: typeof r.name === 'string' ? r.name : undefined,
    description: typeof r.description === 'string' ? r.description : typeof r.short_description === 'string' ? r.short_description : undefined,
    contextWindow: num(top.context_length) ?? num(r.context_length),
    maxOutput: num(top.max_completion_tokens) ?? num(r.max_output_tokens),
    pricing: parsePricing(top.pricing ?? r.pricing),
    modality: typeof arch.modality === 'string' ? arch.modality : undefined,
    params: Array.isArray(top.supported_parameters) ? (top.supported_parameters as string[]) : undefined,
    topProvider: typeof top.name === 'string' ? top.name : undefined,
    created: num(r.created),
  };
}

export class ModelCatalog {
  constructor(private registry: ProviderRegistry) {}

  private endpoint(providerId: string): { base: string; headers: Record<string, string> } | undefined {
    const cfg = this.registry.configs[providerId];
    if (!cfg) return undefined;
    const key = this.registry.apiKey(providerId);
    if (cfg.type === 'anthropic') {
      const base = (cfg.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '');
      return { base: base.endsWith('/v1') ? base : `${base}/v1`, headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' } };
    }
    const base = (cfg.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    return { base, headers: { ...(cfg.headers ?? {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) } };
  }

  /** All models the provider offers, cheapest metadata first. `refresh` bypasses the disk cache. */
  async models(providerId: string, refresh = false): Promise<CatalogModel[]> {
    const cached = refresh ? undefined : readCache<CatalogModel[]>(`models-${providerId}`);
    if (cached) return cached;
    const ep = this.endpoint(providerId);
    if (!ep) throw new Error(`Unknown provider "${providerId}"`);
    const body = (await getJson(`${ep.base}/models`, ep.headers)) as { data?: unknown[] } | undefined;
    const list = (body?.data ?? []).map(parseModel).filter((m): m is CatalogModel => Boolean(m));
    if (list.length) writeCache(`models-${providerId}`, list);
    return list;
  }

  /** Upstream providers serving one model; empty when the provider is not a routing gateway. */
  async routes(providerId: string, model: string, refresh = false): Promise<ModelRoute[]> {
    const name = `routes-${providerId}-${model}`;
    const cached = refresh ? undefined : readCache<ModelRoute[]>(name);
    if (cached) return cached;
    const ep = this.endpoint(providerId);
    if (!ep || this.registry.configs[providerId]?.type !== 'openai-compat') return [];
    let raw: unknown[] = [];
    try {
      const body = (await getJson(`${ep.base}/models/${model}`, ep.headers)) as Record<string, unknown> | undefined;
      // polza: { providers: [...] }; OpenRouter: { data: { endpoints: [...] } }
      const data = (body?.data ?? body) as Record<string, unknown> | undefined;
      const providers = data?.providers ?? data?.endpoints;
      if (Array.isArray(providers)) raw = providers;
    } catch {
      return [];
    }
    const list = raw.map(parseRoute).filter((r): r is ModelRoute => Boolean(r));
    if (list.length) writeCache(name, list);
    return list;
  }

  /** Spend limit and balance for the configured key, when the provider exposes them. */
  async key(providerId: string, refresh = false): Promise<KeyStatus | undefined> {
    const cached = refresh ? undefined : readCache<KeyStatus>(`key-${providerId}`, KEY_TTL_MS);
    if (cached) return cached;
    const ep = this.endpoint(providerId);
    if (!ep || this.registry.configs[providerId]?.type !== 'openai-compat' || !this.registry.apiKey(providerId)) return undefined;
    let status: KeyStatus | undefined;
    try {
      const body = (await getJson(`${ep.base}/key`, ep.headers, 15_000)) as Record<string, unknown> | undefined;
      const d = (body?.data ?? body) as Record<string, unknown> | undefined;
      if (d) {
        status = {
          limit: num(d.limit),
          remaining: num(d.limit_remaining),
          used: num(d.usage),
          reset: typeof d.limit_reset === 'string' ? d.limit_reset : undefined,
          currency: providerId === 'polza' ? 'RUB' : 'USD',
        };
      }
    } catch {
      /* key endpoint is optional */
    }
    try {
      const body = (await getJson(`${ep.base}/balance`, ep.headers, 15_000)) as Record<string, unknown> | undefined;
      const avail = num(body?.available) ?? num(body?.amount);
      if (avail != null) status = { currency: providerId === 'polza' ? 'RUB' : 'USD', ...status, balance: avail };
    } catch {
      /* balance endpoint is optional */
    }
    if (status) writeCache(`key-${providerId}`, status);
    return status;
  }
}

/** Narrow a catalog by a space-separated query over id and display name. */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const terms = q.split(/\s+/);
  return models.filter((m) => {
    const hay = `${m.id} ${m.name ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** "1.2M" / "128k" for context windows. */
export function fmtContext(n?: number): string {
  if (!n) return '—';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

export function fmtMoney(v: number | undefined, currency = 'USD'): string {
  if (v == null) return '—';
  const sym = currency === 'RUB' ? '₽' : currency === 'USD' ? '$' : ` ${currency}`;
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 3 : 4;
  const body = v.toFixed(digits);
  return currency === 'RUB' ? `${body}${sym}` : `${sym}${body}`;
}

/** "$3/$15 per 1M" — the two numbers that actually decide the bill. */
export function fmtPrice(p?: Pricing): string {
  if (!p || (p.in == null && p.out == null)) return 'price n/a';
  return `${fmtMoney(p.in, p.currency)} / ${fmtMoney(p.out, p.currency)} per 1M`;
}
