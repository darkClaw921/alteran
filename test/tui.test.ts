import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch, sleep } from './harness.js';
import { markdown, wrapLine, seg, truncate, bar, fmtTokens } from '../src/tui/lines.js';
import { gateSize, renderGate } from '../src/tui/gate.js';
import { applyTheme, C, type ThemeName } from '../src/tui/theme.js';
import { StageTracker, parseTestOutput } from '../src/tui/stages.js';
import { projectSlug } from '../src/config/paths.js';
import { TUNNEL_START, introFrame, playIntro } from '../src/tui/intro.js';

let dir: string;
let home: string;

/** The side panels need the alternate screen, so those tests opt in explicitly. */
function withPanels(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ panels: true, ...extra }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-tui-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
  process.env.ALTERAN_HOME = home;
  process.env.ALTERAN_CLIPBOARD = 'osc52';
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ALTERAN_HOME;
  delete process.env.ALTERAN_CLIPBOARD;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

describe('text layout', () => {
  it('wraps styled lines without losing text', () => {
    const line = [seg('* '), seg('word '.repeat(20).trim())];
    const wrapped = wrapLine(line, 20, 2);
    expect(wrapped.length).toBeGreaterThan(3);
    for (const l of wrapped) expect(l.reduce((s, x) => s + x.text.length, 0)).toBeLessThanOrEqual(20);
    const joined = wrapped.map((l) => l.map((s) => s.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
    expect(joined.replace(/\* /, '')).toBe('word '.repeat(20).trim());
  });

  it('renders markdown structures', () => {
    const lines = markdown('# Title\n- one **bold**\n- `code`\n\n```\nraw\n```', 60);
    const text = lines.map((l) => l.map((s) => s.text).join('')).join('\n');
    expect(text).toContain('Title');
    expect(text).toContain('- one bold');
    expect(text).toContain('raw');
  });

  it('formats bars and token counts', () => {
    expect(bar(0.5, 10)).toBe('#####-----');
    expect(fmtTokens(148_000)).toBe('148k');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('palette contrast', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it.each(['dark', 'contrast'] as ThemeName[])('keeps every %s colour readable on the panel background', (theme) => {
    applyTheme(theme);
    for (const [name, hex] of Object.entries(C)) {
      if (name === 'bg' || name === 'panel') continue;
      expect.soft(contrast(hex, C.panel), `${theme}.${name} (${hex})`).toBeGreaterThanOrEqual(3);
    }
    applyTheme('dark');
  });
});

describe('gate art', () => {
  it('stays round: the rim sits the same visual distance from the centre', () => {
    const { width, height } = gateSize(44, 15);
    // A cell is twice as tall as wide, so a round gate is about twice as wide as it is tall.
    expect(width / height).toBeGreaterThan(1.7);
    expect(width / height).toBeLessThan(2.4);
    const lines = renderGate(width, height, { chevrons: Array.from({ length: 9 }, () => 'off'), active: false, tick: 0, label: '', sublabel: '' });
    const rows = lines.map((l) => l.map((s) => s.text).join(''));
    const radii: number[] = [];
    rows.forEach((row, y) => {
      const first = row.search(/[#*]/);
      if (first < 0) return;
      const dx = (width - 1) / 2 - first;
      const dy = ((height - 1) / 2 - y) * 2; // rows count double in visual space
      radii.push(Math.hypot(dx, dy));
    });
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    expect(max - min).toBeLessThan(max * 0.25);
  });


  it('renders a ring with nine chevrons at the requested size', () => {
    const lines = renderGate(42, 19, {
      chevrons: ['lit', 'lit', 'active', 'off', 'off', 'off', 'off', 'off', 'off'],
      active: true,
      tick: 3,
      label: '[ RUNNING ]',
      sublabel: 'main',
    });
    expect(lines).toHaveLength(19);
    const text = lines.map((l) => l.map((s) => s.text).join(''));
    expect(text.every((l) => l.length === 42)).toBe(true);
    expect(text.join('\n')).toContain('[ RUNNING ]');
    expect(text.join('')).toContain('#');
  });
});

describe('GRADUS stage tracking', () => {
  it('classifies tools and shell commands into pipeline stages', () => {
    const st = new StageTracker();
    expect(st.classify('Read', {})).toBe('read');
    expect(st.classify('Edit', {})).toBe('patch');
    expect(st.classify('tasks_create', {})).toBe('plan');
    expect(st.classify('Bash', { command: 'pnpm vitest run' })).toBe('tests');
    expect(st.classify('Bash', { command: 'npx tsc --noEmit' })).toBe('typecheck');
    expect(st.classify('Bash', { command: 'eslint .' })).toBe('lint');
    expect(st.classify('Bash', { command: 'git commit -m x' })).toBe('commit');
    expect(st.classify('Bash', { command: 'ls' })).toBeUndefined();
  });

  it('advances stages from events', () => {
    const st = new StageTracker();
    st.onEvent({ type: 'user_message', agentId: 'main', text: 'go' });
    st.onEvent({ type: 'tool_start', agentId: 'main', id: '1', name: 'Read', input: { file_path: 'a.ts' }, summary: 'a.ts' });
    st.onEvent({
      type: 'tool_end',
      agentId: 'main',
      id: '1',
      name: 'Read',
      input: { file_path: 'a.ts' },
      output: { content: 'x' },
      durationMs: 5,
    });
    expect(st.get('read').state).toBe('done');
    expect(st.locked).toBeGreaterThan(0);
  });

  it('parses test runner output', () => {
    expect(parseTestOutput('Test Files 2 passed (2)\nTests 42 passed (42)')).toMatchObject({ passed: 42, total: 42 });
    expect(parseTestOutput('=== 3 failed, 7 passed ===')).toMatchObject({ failed: 3, passed: 7 });
    expect(parseTestOutput('test result: ok. 12 passed; 0 failed')).toMatchObject({ passed: 12, failed: 0 });
    expect(parseTestOutput('All files |   81.25 |')?.coverage).toBe(81.25);
  });
});

describe('boot animation', () => {
  const fakeClock = (stepMs = 45) => {
    let now = 0;
    return () => (now += stepMs);
  };
  const cells = (ansi: string) => ansi.split(/\u001b\[\d+;1H/).slice(1).map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));

  it('approaches the gate, opens the horizon and passes into the tunnel', () => {
    const at = (t: number, exit?: number) => introFrame(t, 80, 24, exit);
    expect(at(0).phase).toBe('approach');
    expect(at(0.5).caption).toMatch(/^CHEVRON \d ENCODED$/);
    expect(at(0.75).caption).toBe('CHEVRON 9 LOCKED');
    expect(at(0.9).phase).toBe('kawoosh');
    expect(at(1.2).caption).toBe('WORMHOLE ESTABLISHED');
    expect(at(TUNNEL_START - 0.1).phase).toBe('enter');
    expect(at(TUNNEL_START + 0.5).phase).toBe('tunnel');
    expect(at(TUNNEL_START + 0.5).caption).toBe('TRAVERSING');
    expect(at(TUNNEL_START + 1, 0.5).phase).toBe('exit');
  });

  it('fills the whole terminal, whatever its size', () => {
    for (const [cols, rows] of [
      [80, 24],
      [211, 57],
      [30, 10],
    ]) {
      for (const t of [0.3, 1.2, TUNNEL_START + 0.4]) {
        const lines = cells(introFrame(t, cols, rows).ansi);
        expect(lines).toHaveLength(rows);
        for (const l of lines) expect([...l]).toHaveLength(cols);
      }
    }
  });

  it('plays on the alternate screen and restores the terminal', async () => {
    let buffer = '';
    const out = { columns: 80, rows: 24, write: (s: string) => ((buffer += s), true) } as unknown as NodeJS.WriteStream;
    await playIntro(out, { frameMs: 0, now: fakeClock(), until: Promise.resolve() });
    expect(buffer.startsWith('\u001b[?1049h')).toBe(true);
    expect(buffer.endsWith('\u001b[?25h\u001b[?1049l')).toBe(true);
    expect(buffer).toContain('CHEVRON');
    expect(buffer).toContain('TRAVERSING');
  });

  it('hurries to the end once the agent is ready', async () => {
    let frames = 0;
    const out = { columns: 80, rows: 24, write: () => (frames++, true) } as unknown as NodeJS.WriteStream;
    await playIntro(out, { frameMs: 0, now: fakeClock(), until: Promise.resolve() });
    // At normal speed the story takes ~46 frames of 45ms; catching up it takes about half that.
    expect(frames).toBeLessThan(30);
  });

  it('keeps the tunnel moving until the agent is ready', async () => {
    let buffer = '';
    const out = { columns: 80, rows: 24, write: (s: string) => ((buffer += s), true) } as unknown as NodeJS.WriteStream;
    let release = () => {};
    const until = new Promise<void>((r) => (release = r));
    const playing = playIntro(out, { frameMs: 1, now: fakeClock(), until });
    await sleep(200);
    // Long past the scripted story, still travelling.
    expect(buffer).toContain('TRAVERSING');
    expect(buffer.endsWith('\u001b[?1049l')).toBe(false);
    release();
    await playing;
    expect(buffer.endsWith('\u001b[?25h\u001b[?1049l')).toBe(true);
  });
});

describe('terminal UI', () => {
  it('renders the three panels and runs a slash command', async () => {
    withPanels();
    const { io } = await launch({ cwd: dir, model: 'ollama:test', mode: 'acceptEdits' }, 200, 44);
    await sleep(700);
    let screen = io.screen();
    expect(screen).toContain('[ A L T E R A N ]');
    expect(screen).not.toContain('HERMES');
    expect(screen).toContain('ASTRIA PORTA');
    expect(screen).toContain('GRADUS');
    expect(screen).toContain('CONSILIUM');
    expect(screen).toContain('CLIPEUS');
    expect(screen).toContain('MODE: ACCEPTEDITS');

    io.key('/iris');
    await sleep(300);
    expect(io.screen()).toContain('/iris');
    io.key('\r');
    await sleep(200);
    io.key('\r');
    await sleep(500);
    expect(io.screen()).toContain('Allow rules:');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await sleep(300);
  }, 30000);

  it('animates the gate only until the first prompt', async () => {
    // Wide enough for the gate art: below that the splash is text only, with nothing to animate.
    withPanels();
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 200, 40);
    await sleep(600);
    io.clear();
    await sleep(300);
    const first = io.text();
    io.clear();
    await sleep(700);
    // The rim pulse and the dust field move, so consecutive frames differ.
    expect(io.text()).not.toBe(first);

    // Once work starts, the start screen is done: the resting gate is static from then on.
    io.key('/mode default');
    await sleep(150);
    io.key('\r');
    await sleep(150);
    io.key('\r');
    await sleep(700);
    io.clear();
    await sleep(700);
    expect(io.text()).toBe('');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await sleep(300);
  }, 30000);

  it('starts inline and remounts with the side panels on ctrl+b', async () => {
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 200, 44);
    await sleep(700);
    let screen = io.text();
    expect(screen).not.toContain('-- ASTRIA PORTA ---');
    expect(screen).toContain('^B panels on');

    io.clear();
    io.key('\u0002');
    await sleep(700);
    screen = io.text();
    expect(screen).toContain('-- ASTRIA PORTA ---');
    expect(screen).toContain('^B console only');

    io.clear();
    io.key('\u0002');
    await sleep(700);
    // The last frame written is the inline one; the panel frame stays behind in the scrollback.
    const tail = io.text().split('\n').slice(-25).join('\n');
    expect(tail).not.toContain('-- ASTRIA PORTA ---');
    expect(tail).toContain('^B panels on');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await sleep(300);
  }, 30000);

  it('scrolls the panel layout with the mouse wheel', async () => {
    withPanels();
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 100, 20);
    await sleep(700);
    // Fill the console so there is something to scroll through.
    for (let i = 0; i < 12; i++) {
      io.key(`/mode line${i}`);
      await sleep(50);
      io.key('\r');
      await sleep(50);
    }
    await sleep(300);
    const wheel = async (up: boolean, times = 1) => {
      for (let i = 0; i < times; i++) {
        io.key(`\u001b[<${up ? 64 : 65};10;10M`);
        await sleep(20);
      }
    };
    // The earliest lines have scrolled off the top of a 20-row terminal.
    expect(io.screen()).not.toContain('line0"');
    const bottom = io.screen();

    // One notch moves one line — the whole point, so the view barely shifts.
    await wheel(true, 1);
    await sleep(250);
    expect(io.screen()).not.toBe(bottom);

    // Keep scrolling until the oldest entry comes into view.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await wheel(true, 1);
      await sleep(60);
      reached = io.screen().includes('line0"');
    }
    expect(reached).toBe(true);

    await wheel(false, 60);
    await sleep(400);
    expect(io.screen()).toContain('line11');
    // The escape sequence must never land in the input line.
    expect(io.screen()).not.toContain('[<64');

    // F7 turns mouse reporting off so drag-selection works again.
    io.key('\u001b[18~');
    await sleep(400);
    let screen = io.screen();
    expect(screen).toContain('Mouse wheel scrolling OFF');
    expect(screen).toContain('F7 mouse off');
    io.key('\u001b[18~');
    await sleep(400);
    screen = io.screen();
    expect(screen).toContain('Mouse wheel scrolling ON');
    expect(screen).toContain('F7 mouse on');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await sleep(300);
  }, 30000);

  it('collapses side panels on narrow terminals', async () => {
    withPanels();
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 90, 30);
    await sleep(700);
    const screen = io.screen();
    expect(screen).toContain('[ A L T E R A N ]');
    expect(screen).not.toContain('ASTRIA PORTA ---');
    expect(screen).not.toContain('CONSILIUM');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await sleep(300);
  }, 30000);




  it('shows the restored conversation when started with --resume', async () => {
    const sdir = path.join(home, 'sessions', projectSlug(dir));
    fs.mkdirSync(sdir, { recursive: true });
    const id = '21e5d0e1-0000-0000-0000-000000000000';
    fs.writeFileSync(
      path.join(sdir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'meta', id, cwd: dir, root: dir, model: 'ollama:test', createdAt: new Date().toISOString(), title: 'parser fix' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'fix the config parser' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: empty sections no longer crash it.' }] } }),
      ].join('\n') + '\n',
    );

    const started = await launch({ cwd: dir, model: 'ollama:test', resume: '21e5d0e1' }, 110, 28);
    await sleep(700);
    const screen = started.io.screen();
    expect(screen).toContain('Resumed session 21e5d0e1');
    expect(screen).toContain('fix the config parser');
    expect(screen).toContain('Done: empty sections no longer crash it.');
    started.io.key('\u0003');
    await sleep(300);
    started.io.key('\u0003');
    await started.done;

    // An id nobody has says so instead of opening a silently empty session.
    const missing = await launch({ cwd: dir, model: 'ollama:test', resume: 'deadbeef' }, 110, 28);
    await sleep(700);
    expect(missing.io.screen()).toContain('No session in this project starts with "deadbeef"');
    missing.io.key('\u0003');
    await sleep(300);
    missing.io.key('\u0003');
    await missing.done;
  }, 30000);

  it('tells the user how to come back when the session ends', async () => {
    const sdir = path.join(home, 'sessions', projectSlug(dir));
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, '33333333-3333-3333-3333-333333333333.jsonl'),
      [
        JSON.stringify({ type: 'meta', id: '33333333-3333-3333-3333-333333333333', cwd: dir, root: dir, model: 'ollama:test', createdAt: new Date().toISOString(), title: 'earlier work' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'earlier work' }] } }),
      ].join('\n') + '\n',
    );
    const { io, done } = await launch({ cwd: dir, model: 'ollama:test' }, 120, 30);
    await sleep(600);
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await done;
    const tail = io.screen();
    expect(tail).toContain('alteran --resume');
    expect(tail).toContain('pick from 1 older session');
    expect(tail).toContain('alteran sessions');
  }, 30000);

  it('resumes a saved session from the picker and replays its transcript', async () => {
    const sdir = path.join(home, 'sessions', projectSlug(dir));
    fs.mkdirSync(sdir, { recursive: true });
    const write = (id: string, title: string, turns: number) => {
      const lines = [JSON.stringify({ type: 'meta', id, cwd: dir, root: dir, model: 'ollama:test', createdAt: new Date().toISOString(), title })];
      for (let i = 0; i < turns; i++) {
        lines.push(JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `${title} #${i}` }] } }));
        lines.push(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] } }));
      }
      fs.writeFileSync(path.join(sdir, `${id}.jsonl`), lines.join('\n') + '\n');
    };
    write('11111111-1111-1111-1111-111111111111', 'parser fix', 2);
    write('22222222-2222-2222-2222-222222222222', 'webhook support', 3);

    const { io, done } = await launch({ cwd: dir, model: 'ollama:test' }, 130, 34);
    await sleep(700);
    io.key('/resume');
    await sleep(300);
    io.key('\r');
    await sleep(500);
    let screen = io.screen();
    expect(screen).toContain('RESUME SESSION');
    expect(screen).toContain('parser fix');
    expect(screen).toContain('webhook support');

    // Filter down to the second session, then resume it.
    io.key('webhook');
    await sleep(300);
    expect(io.screen()).toContain('1/2 sessions');
    io.clear();
    io.key('\r');
    await sleep(600);
    screen = io.text();
    expect(screen).toContain('Resumed session 22222222');
    expect(screen).toContain('webhook support #2');
    expect(screen).not.toContain('RESUME SESSION');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await done;
    // Leaving prints the exact command that returns to the session just continued.
    expect(io.screen()).toContain('alteran --resume 22222222');
  }, 30000);

  it('toggles help as an overlay instead of pushing it into the transcript', async () => {
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 120, 34);
    await sleep(700);
    const before = io.screen();
    expect(before).not.toContain('-- HELP');
    io.clear();
    io.key('?');
    await sleep(400);
    let screen = io.text();
    expect(screen).toContain('-- HELP');
    expect(screen).toContain('/run-phase');
    io.clear();
    io.key('\u001b[B');
    await sleep(300);
    expect(io.text()).toContain('2-');
    io.clear();
    io.key('?');
    await sleep(400);
    screen = io.text();
    expect(screen).not.toContain('-- HELP');
    expect(screen).toContain('? shortcuts');
    io.key('\u0003');
    io.key('\u0003');
    await sleep(300);
  }, 30000);

  it('animates the start screen inline, then writes nothing at all', async () => {
    const { io } = await launch({ cwd: dir, model: 'ollama:test' }, 100, 24);
    await sleep(900);
    io.clear();
    await sleep(700);
    // The start screen moves: there is nothing above it to scroll away from yet.
    expect(io.text()).not.toBe('');

    io.key('/mode default');
    await sleep(150);
    io.key('\r');
    await sleep(150);
    io.key('\r');
    await sleep(700);
    io.clear();
    await sleep(1000);
    // From the first message on, any repaint would yank a scrolled-up terminal back to the bottom.
    expect(io.text()).toBe('');
    io.key('\u0003');
    await sleep(300);
    io.key('\u0003');
    await sleep(300);
  }, 30000);




  it('picks a model and pins an upstream provider from /model', async () => {
    withPanels({ providers: { polza: { type: 'openai-compat', apiKey: 'k' } } });
    const catalog = {
      data: [
        {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek: V4.1 Flash',
          top_provider: { context_length: 1_048_576, pricing: { prompt_per_million: '13.21', completion_per_million: '39.64', currency: 'RUB' } },
        },
        { id: 'anthropic/claude-opus-5', top_provider: { context_length: 1_000_000, pricing: { prompt_per_million: '471.96', completion_per_million: '2359.84', currency: 'RUB' } } },
      ],
    };
    const detail = {
      id: 'deepseek/deepseek-v4.1-flash',
      providers: [
        { name: 'deepseek', context_length: 1_048_576, pricing: { prompt_per_million: '17.69', completion_per_million: '70.79', currency: 'RUB' } },
        { name: 'morph/fp8', context_length: 1_048_576, pricing: { prompt_per_million: '15.92', completion_per_million: '63.71', currency: 'RUB' } },
      ],
    };
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      const body = u.includes('/models/') ? detail : u.endsWith('/models') ? catalog : { limit: 200, limit_remaining: 199.09, limit_reset: 'weekly' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const { io } = await launch({ cwd: dir, model: 'polza:deepseek/deepseek-v4.1-flash', mode: 'acceptEdits' }, 200, 44);
    await sleep(500);
    expect(io.screen()).toContain('KEY 199.09/200.00₽');

    io.key('/model');
    await sleep(200);
    io.key('\r');
    await sleep(600);
    let screen = io.screen();
    expect(screen).toContain('MODEL / polza');
    expect(screen).toContain('deepseek/deepseek-v4.1-flash');
    expect(screen).toContain('13.21₽/39.64₽');

    // Right opens the providers pane with per-provider prices; Enter pins the highlighted one.
    io.key('\u001b[C');
    await sleep(500);
    screen = io.screen();
    expect(screen).toContain('PROVIDERS / deepseek/deepseek-v4.1-flash');
    expect(screen).toContain('morph/fp8');
    // Tick two providers: the order they are ticked in becomes the fallback order.
    io.key('\u001b[B');
    await sleep(200);
    io.key(' ');
    await sleep(200);
    io.key('\u001b[A');
    await sleep(200);
    io.key(' ');
    await sleep(200);
    screen = io.screen();
    expect(screen).toContain('order: morph/fp8 > deepseek');
    expect(screen).toContain('[1] morph/fp8');
    expect(screen).toContain('[2] deepseek');
    io.key('\r');
    await sleep(400);
    screen = io.screen();
    expect(screen).toContain('via morph/fp8, deepseek');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    expect(saved.routes['polza:deepseek/deepseek-v4.1-flash']).toEqual(['morph/fp8', 'deepseek']);
    io.key('\u0003');
    io.key('\u0003');
    await sleep(300);
  }, 30000);


});
