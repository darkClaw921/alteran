import { z } from 'zod';
import { fail, ok, type Tool } from './types.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const TIMEOUT_MS = 60_000;

/** Which backend answers a query, and with what. Configured, never guessed from the environment. */
export interface WebSearchConfig {
  provider?: 'brave' | 'tavily' | 'searxng';
  apiKey?: string;
  baseURL?: string;
  /** Results to ask for; the tool's own argument can lower it. */
  count?: number;
}

/**
 * The key the configured backend needs, or undefined when it is running without one.
 *
 * Nothing here invents a provider: an unconfigured `WebSearch` says so and stops, rather than
 * quietly falling back to scraping a search page, which would break the moment the markup moved.
 */
export function resolveBackend(cfg: WebSearchConfig | undefined): { provider: 'brave' | 'tavily' | 'searxng'; apiKey?: string; baseURL?: string } | { error: string } {
  const provider = cfg?.provider;
  if (!provider) {
    return {
      error:
        'Web search is not configured. Set `webSearch.provider` (brave | tavily | searxng) in settings.json, with `webSearch.apiKey` or the BRAVE_API_KEY / TAVILY_API_KEY environment variable. SearxNG needs `webSearch.baseURL` instead of a key.',
    };
  }
  const envKey = provider === 'brave' ? process.env.BRAVE_API_KEY : provider === 'tavily' ? process.env.TAVILY_API_KEY : undefined;
  const apiKey = cfg?.apiKey ?? envKey;
  if (provider === 'searxng') {
    if (!cfg?.baseURL) return { error: 'SearxNG needs `webSearch.baseURL` (e.g. "https://searx.example.org").' };
    return { provider, baseURL: cfg.baseURL.replace(/\/$/, '') };
  }
  if (!apiKey) return { error: `${provider} needs an API key: set webSearch.apiKey or ${provider === 'brave' ? 'BRAVE_API_KEY' : 'TAVILY_API_KEY'}.` };
  return { provider, apiKey, baseURL: cfg?.baseURL?.replace(/\/$/, '') };
}

async function getJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { ...init, signal, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** Query each backend and normalize to the same three fields. */
export async function searchWeb(
  backend: Exclude<ReturnType<typeof resolveBackend>, { error: string }>,
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (backend.provider === 'brave') {
      const base = backend.baseURL ?? 'https://api.search.brave.com';
      const json = (await getJson(`${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { headers: { 'X-Subscription-Token': backend.apiKey! } }, ctl.signal)) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      return (json.web?.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: stripTags(r.description ?? '') }));
    }
    if (backend.provider === 'tavily') {
      const base = backend.baseURL ?? 'https://api.tavily.com';
      const json = (await getJson(
        `${base}/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: backend.apiKey, query, max_results: count, search_depth: 'basic' }),
        },
        ctl.signal,
      )) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      return (json.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
    }
    const json = (await getJson(`${backend.baseURL}/search?q=${encodeURIComponent(query)}&format=json`, {}, ctl.signal)) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (json.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Search snippets arrive with markup; the model should not have to read `<b>` around a keyword. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .trim();
}

const schema = z.object({
  query: z.string().min(1).describe('The search query'),
  count: z.number().int().min(1).max(20).optional().describe('Results to return (default 5)'),
});

export const WebSearchTool: Tool<z.infer<typeof schema>> = {
  name: 'WebSearch',
  category: 'network',
  timeoutMs: TIMEOUT_MS + 5_000,
  description: `Searches the web and returns titles, URLs and snippets.
- The backend (brave, tavily or searxng) is configured in settings; without one the tool says so rather than guessing.
- Use exact, specific queries; this returns links, so follow up with WebFetch to read a page in full.`,
  schema,
  summarize: (i) => i.query,
  async run(input, ctx) {
    const backend = resolveBackend(ctx.runtime.settings.webSearch);
    if ('error' in backend) return fail(backend.error);
    const configured = ctx.runtime.settings.webSearch?.count ?? 5;
    const count = Math.min(input.count ?? configured, 20);
    let hits: SearchHit[];
    try {
      hits = await searchWeb(backend, input.query, count, ctx.signal);
    } catch (e) {
      if (ctx.signal.aborted) return fail('Search interrupted.');
      return fail(`Search failed (${backend.provider}): ${(e as Error).message}`);
    }
    if (!hits.length) return ok('No results.', { summary: 'No results' });
    return ok(formatHits(input.query, hits), {
      summary: `${hits.length} result${hits.length === 1 ? '' : 's'} for "${input.query}"`,
      lines: hits.map((h) => h.url),
    });
  },
};

function formatHits(query: string, hits: SearchHit[]): string {
  return [
    `<search query="${query}">`,
    ...hits.map((h, i) => [`${i + 1}. ${h.title || '(untitled)'}`, `   ${h.url}`, ...(h.snippet ? h.snippet.split('\n').map((l) => `   ${l}`) : [])].join('\n')),
    '</search>',
  ].join('\n');
}
