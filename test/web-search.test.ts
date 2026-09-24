import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRuntime as scriptedRuntime, textTurn, useTempDirs } from './scripted.js';
import { WebSearchTool } from '../src/tools/web-search.js';

const dirs = useTempDirs('websearch');
const dir = () => dirs.dir;

afterEach(() => vi.unstubAllGlobals());

function configure(webSearch: unknown) {
  fs.mkdirSync(path.join(dir(), '.alteran'), { recursive: true });
  fs.writeFileSync(path.join(dir(), '.alteran', 'settings.json'), JSON.stringify({ webSearch }));
}

async function run(query = 'gate dialer', signal = new AbortController().signal) {
  const { rt } = await scriptedRuntime(dirs, [textTurn('ok')]);
  const input = WebSearchTool.schema!.parse({ query });
  return WebSearchTool.run(input, { runtime: rt, agent: rt.main, signal, toolUseId: 't1' });
}

const jsonResponse = (body: unknown, ok = true, status = 200) => ({ ok, status, statusText: ok ? 'OK' : 'Bad Request', json: async () => body }) as Response;

describe('web search', () => {
  it('says how to configure a backend instead of guessing one', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args);
      return jsonResponse({});
    });
    const out = await run();
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain('webSearch.provider');
    expect(calls).toHaveLength(0);
  });

  it('searches with brave and normalizes the results', async () => {
    configure({ provider: 'brave', apiKey: 'secret' });
    let seenUrl = '';
    let seenToken: string | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenToken = (init.headers as Record<string, string>)['X-Subscription-Token'];
      return jsonResponse({
        web: { results: [{ title: 'Gate dialer', url: 'https://example.com/a', description: 'the <b>dial</b> &amp; the ring' }] },
      });
    });
    const out = await run('gate dialer');
    expect(out.isError).toBeUndefined();
    expect(seenUrl).toContain('/res/v1/web/search?q=gate%20dialer');
    expect(seenToken).toBe('secret');
    expect(String(out.content)).toContain('Gate dialer');
    expect(String(out.content)).toContain('https://example.com/a');
    // Snippets lose their markup before the model ever sees them.
    expect(String(out.content)).toContain('the dial & the ring');
    expect(String(out.content)).not.toContain('<b>');
  });

  it('posts the key when the backend is tavily', async () => {
    configure({ provider: 'tavily', apiKey: 'tvly' });
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return jsonResponse({ results: [{ title: 'T', url: 'https://t.example', content: 'snippet' }] });
    });
    const out = await run('hello');
    expect(body.api_key).toBe('tvly');
    expect(body.query).toBe('hello');
    expect(String(out.content)).toContain('https://t.example');
  });

  it('needs a base URL for searxng and uses it when given', async () => {
    configure({ provider: 'searxng' });
    expect(String((await run()).content)).toContain('baseURL');

    configure({ provider: 'searxng', baseURL: 'https://searx.example.org/' });
    let seenUrl = '';
    vi.stubGlobal('fetch', async (url: string) => {
      seenUrl = String(url);
      return jsonResponse({ results: [{ title: 'S', url: 'https://s.example', content: 'body' }] });
    });
    const out = await run('x');
    expect(seenUrl).toBe('https://searx.example.org/search?q=x&format=json');
    expect(String(out.content)).toContain('https://s.example');
  });

  it('reports a backend failure instead of an empty result', async () => {
    configure({ provider: 'brave', apiKey: 'secret' });
    vi.stubGlobal('fetch', async () => jsonResponse({}, false, 429));
    const out = await run();
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain('429');
  });

  it('takes the key from the environment when settings have none', async () => {
    configure({ provider: 'brave' });
    vi.stubGlobal('fetch', async () => jsonResponse({ web: { results: [] } }));
    const before = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'from-env';
    try {
      expect(String((await run()).content)).toContain('No results');
      process.env.BRAVE_API_KEY = '';
      expect(String((await run()).content)).toContain('needs an API key');
    } finally {
      if (before === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = before;
    }
  });
});
