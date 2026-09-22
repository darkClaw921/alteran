import fs from 'node:fs';
import path from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, render, useApp, useInput, useStdin, useStdout, useWindowSize } from 'ink';
import fg from 'fast-glob';
import { InterruptedError } from '../core/agent.js';
import { listSlashCommands, runSlashCommand, resumeList } from '../core/commands.js';
import { Runtime, type PlanDecision, type UIBridge } from '../core/runtime.js';
import type { PermissionAnswer, PermissionRequest } from '../permissions/permissions.js';
import type { PermissionMode, Settings } from '../config/settings.js';
import type { AskQuestions } from '../tools/misc-tools.js';
import { runShell } from '../tools/bash.js';
import { packageRoot } from '../config/paths.js';
import { gitDiff } from './git.js';
import { fmtClock, fmtTokens, seg, truncate, wheelDelta, type Line } from './lines.js';
import { UiStore } from './store.js';
import { startIntro, type IntroHandle } from './intro.js';
import { SessionStore } from '../core/session.js';
import { paint } from '../util/color.js';
import { applyTheme, C, LEFT_WIDTH, RIGHT_WIDTH, SHOW_LEFT_MIN, SHOW_RIGHT_MIN, type ThemeName } from './theme.js';
import { LiveTail, StaticTranscript, StatusLine, StreamView } from './components/Console.js';
import { DialogView, type DialogState } from './components/Dialog.js';
import { ModelPickerView, type PickerState } from './components/ModelPicker.js';
import { HelpPanel } from './components/Help.js';
import { SessionPickerView, filterSessions, type SessionPickerState } from './components/SessionPicker.js';
import { filterModels, fmtMoney } from '../providers/catalog.js';
import { copyToClipboard } from './clipboard.js';
import { updateUserSettings } from '../config/settings.js';
import { GatePanel } from './components/GatePanel.js';
import { InputBox, SuggestionList, type Suggestion } from './components/InputBox.js';
import { Lines } from './components/Lines.js';
import { SystemsPanel } from './components/SystemsPanel.js';

export interface TuiOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  mode?: PermissionMode;
  reasoning?: Settings['reasoning'];
  resume?: string;
  pickResume?: boolean;
  mcp?: boolean;
  /** The boot animation, when the CLI already started it before loading the app. */
  intro?: IntroHandle;
}

const VERSION = JSON.parse(fs.readFileSync(`${packageRoot()}/package.json`, 'utf8')).version as string;

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'autonomous'];
const F_KEYS: Record<string, string> = {
  '\u001bOP': 'f1',
  '\u001bOQ': 'f2',
  '\u001bOR': 'f3',
  '\u001bOS': 'f4',
  '\u001b[11~': 'f1',
  '\u001b[12~': 'f2',
  '\u001b[13~': 'f3',
  '\u001b[14~': 'f4',
  '\u001b[15~': 'f5',
  '\u001b[17~': 'f6',
  '\u001b[18~': 'f7',
};

/** One-character column separator, as in the mockup. */
function Divider({ height }: { height: number }) {
  return (
    <Box flexDirection="column" width={1} height={height} flexShrink={0} backgroundColor={C.bg}>
      <Lines lines={Array.from({ length: height }, () => [seg(':', C.divider)])} />
    </Box>
  );
}

function TopBar({ store, rt, width }: { store: UiStore; rt: Runtime; width: number }) {
  const ctx = Math.round((store.contextTokens / store.contextWindow) * 100);
  const porta = store.awaiting ? 'ASTRIA PORTA: IRIS HOLD' : store.running ? 'ASTRIA PORTA: OPEN' : 'ASTRIA PORTA: DORMANT';
  const portaColor = store.awaiting ? C.amber : store.running ? C.cyan : C.muted;
  const left: Line = [
    seg('[ A L T E R A N ]', C.gold, { bold: true }),
    seg(`  == ANCIENT GATE NETWORK // AGENT TERMINAL -- alteran v${VERSION} ==`, C.muted),
  ];
  const right: Line = [
    seg(porta, portaColor),
    seg(' | ', C.dim),
    seg(`CTX ${ctx}%`, ctx > 85 ? C.red : ctx > 60 ? C.amber : C.muted),
    seg(' | ', C.dim),
    seg(`RUN ${fmtClock(store.elapsed)}`, C.muted),
  ];
  const lw = left.reduce((s, x) => s + x.text.length, 0);
  const rw = right.reduce((s, x) => s + x.text.length, 0);
  const line: Line = lw + rw + 2 > width ? [...left] : [...left, seg(' '.repeat(Math.max(1, width - lw - rw))), ...right];
  return <Lines lines={[line, [seg('='.repeat(width), C.rule)]]} />;
}

function StatusBar({ store, rt, width }: { store: UiStore; rt: Runtime; width: number }) {
  const mcp = [...rt.mcp.servers.values()];
  const connected = mcp.filter((s) => s.status === 'connected');
  const tools = rt.toolsFor(rt.main).length;
  const left: Line = [
    seg(`MODE: ${rt.mode.toUpperCase()}`, rt.mode === 'autonomous' ? C.amber : rt.mode === 'plan' ? C.cyan : C.muted),
    seg(' | ', C.dim),
    seg(`MODEL: ${truncate(rt.model.id, 34)}`, C.muted),
    seg(' | ', C.dim),
    seg(`TOOLS: ${tools}${mcp.length ? ` (mcp ${connected.length}/${mcp.length})` : ''}`, C.muted),
  ];
  const pct = Math.max(0, 100 - Math.round((store.contextTokens / store.contextWindow) * 100));
  const k = store.keyStatus;
  const cur = store.costCurrency || k?.currency || 'USD';
  // Session spend first: it is what the run is costing right now. Key balance second.
  const spent: Line = [
    seg(' | ', C.dim),
    seg(`SES ${fmtTokens(store.sessionTokens)}`, C.muted),
    seg(store.sessionCost ? ` - ${fmtMoney(store.sessionCost, cur)}` : '', C.amber),
  ];
  const balance = k?.balance ?? k?.remaining;
  const low = k?.limit ? (balance ?? 0) / k.limit < 0.1 : false;
  const keyLine: Line = k
    ? [
        seg(' | ', C.dim),
        seg('KEY ', C.muted),
        // Balance and limit share one currency symbol to keep the bar short.
        seg(k.limit ? `${(balance ?? 0).toFixed(2)}/${fmtMoney(k.limit, k.currency)}` : fmtMoney(balance, k.currency), low ? C.red : C.green),
      ]
    : [];
  const budget: Line = [seg(`BUDGET ${fmtTokens(store.contextTokens)}/${fmtTokens(store.contextWindow)} - ${pct}% LEFT`, C.muted)];
  const branch: Line = [seg(' | ', C.dim), seg(`[ ^ ${store.git?.isRepo ? (store.git.upstream ?? store.git.branch) : 'no git'} ]`, C.cyan)];
  const lw = left.reduce((s, x) => s + x.text.length, 0);
  const wide = (l: Line) => l.reduce((s, x) => s + x.text.length, 0);
  // Drop the optional groups (key, then session) when the bar would not fit.
  let right: Line = [...budget, ...spent, ...keyLine, ...branch];
  if (lw + wide(right) + 2 > width) right = [...budget, ...spent, ...branch];
  if (lw + wide(right) + 2 > width) right = [...budget, ...branch];
  const line: Line = lw + wide(right) + 2 > width ? left : [...left, seg(' '.repeat(Math.max(1, width - lw - wide(right)))), ...right];
  return <Lines lines={[[seg('='.repeat(width), C.rule)], line]} />;
}

/** One compact line under the prompt: the panels' information without the panels. */
function InlineStatus({ store, rt, width }: { store: UiStore; rt: Runtime; width: number }) {
  const info = rt.registry.info(rt.model);
  const left = Math.max(0, 100 - Math.round((store.contextTokens / (info.contextWindow || 1)) * 100));
  const k = store.keyStatus;
  const cur = store.costCurrency || k?.currency || 'USD';
  const git = store.git?.isRepo ? (store.git.upstream ?? store.git.branch) : 'no git';
  const line: Line = [
    seg(rt.mode.toUpperCase(), rt.mode === 'autonomous' ? C.amber : rt.mode === 'plan' ? C.cyan : C.muted),
    seg(' · ', C.dim),
    seg(truncate(rt.model.id, 34), C.muted),
    seg(' · ', C.dim),
    seg(`ctx ${left}% left`, C.muted),
    seg(store.sessionTokens ? ` · ${fmtTokens(store.sessionTokens)} tok` : '', C.muted),
    seg(store.sessionCost ? ` ${fmtMoney(store.sessionCost, cur)}` : '', C.amber),
    seg(k ? ` · key ${fmtMoney(k.balance ?? k.remaining, k.currency)}` : '', C.green),
    seg(` · ${git}`, C.cyan),
  ];
  return <Lines lines={[truncateLine(line, width)]} />;
}

function truncateLine(line: Line, width: number): Line {
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    if (used >= width) break;
    const text = s.text.slice(0, width - used);
    used += text.length;
    out.push({ ...s, text });
  }
  return out;
}

interface AppProps {
  rt: Runtime;
  store: UiStore;
  /** Turns terminal mouse reporting on/off; returns the new state. */
  setMouse: (on: boolean) => boolean;
  /** Inline layout (no alternate screen): the transcript is ordinary terminal output. */
  inline: boolean;
  /** Ask startTui to remount in the other layout. */
  onLayout: (inline: boolean) => void;
  /** Wipe what Ink has drawn (including already-printed inline output). */
  clearScreen: () => void;
  dialogRef: React.MutableRefObject<((d: DialogState | null) => void) | null>;
  initialPrompt?: string;
  pickResume?: boolean;
}

function App({ rt, store, setMouse, inline, onLayout, clearScreen, dialogRef, initialPrompt, pickResume }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const stdin = useStdin() as unknown as { internal_eventEmitter?: { on(e: string, fn: (s: string) => void): void; off(e: string, fn: (s: string) => void): void } };
  const size = useWindowSize();
  const [, force] = useState(0);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState | null>(null);

  const [queue, setQueue] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [mouseOn, setMouseOn] = useState(!inline && rt.settings.mouse !== false);
  /** Help overlay: toggled with `?` or /help, scrolled with the arrows, never pushed to history. */
  const [help, setHelp] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const filesRef = useRef<string[] | null>(null);
  const busyRef = useRef(false);

  dialogRef.current = setDialog;

  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    return () => {
      unsub();
    };
  }, [store]);
  const animateRef = useRef(true);
  useEffect(() => {
    const t = setInterval(() => {
      store.tick++;
      // Idle animation repaints at half rate: it should be alive, not expensive.
      if (store.running || store.awaiting || (animateRef.current && store.tick % 2 === 0)) force((n) => n + 1);
    }, 120);
    return () => clearInterval(t);
  }, [store]);

  // Only the start screen animates. Until the first prompt there is nothing above it to scroll,
  // so repainting is free; from the first message on, the console stays perfectly still, because
  // any repaint would drag a scrolled-up terminal back to the bottom.
  const started = store.entries.some((e) => e.kind === 'user');
  store.animateSplash = !started;
  animateRef.current = !busyRef.current && !started;

  const width = size.columns ?? 120;
  const height = size.rows ?? 40;
  const showLeft = width >= SHOW_LEFT_MIN && !inline;
  const showRight = width >= SHOW_RIGHT_MIN && !inline;
  const consoleWidth = Math.max(40, width - (showLeft ? LEFT_WIDTH + 1 : 0) - (showRight ? RIGHT_WIDTH + 1 : 0) - 4);
  const bodyHeight = Math.max(8, height - 4);

  const pushInfo = useCallback((text: string, title?: string) => store.push({ kind: 'info', text, title }), [store]);

  const runTask = useCallback(
    async (fn: (signal: AbortSignal) => Promise<unknown>, prompt?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const ac = new AbortController();
      abortRef.current = ac;
      store.startRun(prompt ?? store.lastPrompt);
      try {
        await fn(ac.signal);
      } catch (e) {
        if (e instanceof InterruptedError || ac.signal.aborted) store.push({ kind: 'notice', level: 'warn', text: 'Interrupted', t: store.rel() });
        else store.push({ kind: 'error', text: (e as Error).message ?? String(e) });
      } finally {
        busyRef.current = false;
        abortRef.current = null;
        store.endRun();
      }
    },
    [store],
  );

  const submitPrompt = useCallback(
    async (text: string) => {
      await runTask((signal) => rt.main.send(text, signal), text);
    },
    [rt, runTask],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 200));
      setHistIdx(-1);
      if (busyRef.current) {
        setQueue((q) => [...q, text]);
        return;
      }
      if (text.startsWith('/')) {
        const res = await runSlashCommand(rt, text);
        switch (res.kind) {
          case 'info':
            store.push({ kind: 'user', text, t: store.rel() });
            pushInfo(res.text);
            return;
          case 'error':
            store.push({ kind: 'error', text: res.text });
            return;
          case 'clear':
            clearScreen();
            store.reset();
            store.todos = [];
            store.refreshConsilium();
            store.changed();
            return;
          case 'exit':
            exit();
            return;
          case 'ui':
            if (res.action === 'help') setHelp((h) => (h === null ? 0 : null));
            if (res.action === 'resume') {
              const wanted = res.arg ? resumeList(rt).find((x) => x.id.startsWith(res.arg!)) : undefined;
              if (res.arg && !wanted) store.push({ kind: 'error', text: `No session starts with "${res.arg}"` });
              else if (wanted) resumeSession(wanted.file);
              else openResume();
            }
            if (res.action === 'diff') void showDiff();
            if (res.action === 'tasks') void handleSubmit('/phases');
            if (res.action === 'model') void openModelPicker();
            if (res.action === 'context') {
              store.refreshContext();
              if (store.contextReport) store.push({ kind: 'context', report: store.contextReport });
              store.changed();
            }
            if (res.action === 'copy') copyLast();
            if (res.action === 'bare') onLayout(!inline);
            if (res.action === 'mouse') toggleMouse();
            return;
          case 'task':
            store.push({ kind: 'user', text, t: store.rel() });
            await runTask(async (signal) => {
              const out = await res.run(signal);
              if (out) pushInfo(out);
            }, text);
            return;
          case 'prompt':
            if (res.display) store.push({ kind: 'user', text: res.display, t: store.rel() });
            await submitPrompt(res.text);
            return;
        }
      }
      await submitPrompt(text);
    },
    [rt, store, exit, pushInfo, runTask, submitPrompt],
  );

  // Drain queued messages once the current run finishes.
  useEffect(() => {
    if (!busyRef.current && queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest);
      void handleSubmit(next);
    }
  }, [queue, store.running]);

  const showDiff = useCallback(async () => {
    const d = await gitDiff(rt.cwd);
    store.push({ kind: 'diff', text: d.trim() || 'No changes in the working tree' });
    store.changed();
  }, [rt, store]);

  const openModelPicker = useCallback(
    async (provider = rt.model.provider, refresh = false) => {
      const providers = [...new Set([rt.model.provider, ...rt.registry.available()])];
      const base: PickerState = {
        provider,
        providers,
        models: [],
        query: '',
        index: 0,
        pane: 'models',
        routes: [],
        routeIndex: 0,
        chosen: [],
        current: rt.model.id,
        loading: `Loading the ${provider} catalog…`,
      };
      setPicker(base);
      try {
        const models = await rt.catalog.models(provider, refresh);
        const index = Math.max(0, models.findIndex((m) => m.id === rt.model.model));
        setPicker({ ...base, models, index, loading: undefined, pinned: rt.registry.route({ ...rt.model, provider, model: models[index]?.id ?? '', id: `${provider}:${models[index]?.id ?? ''}` }) });
      } catch (e) {
        setPicker({ ...base, loading: undefined, error: `Catalog unavailable: ${(e as Error).message}` });
      }
    },
    [rt],
  );

  /** Fetch the upstream providers for the highlighted model and switch to that pane. */
  const openRoutes = useCallback(
    async (state: PickerState) => {
      const model = filterModels(state.models, state.query)[state.index];
      if (!model) return;
      const ref = { provider: state.provider, model: model.id, id: `${state.provider}:${model.id}` };
      const pinned = rt.registry.route(ref);
      setPicker({ ...state, pane: 'routes', routes: [], routeIndex: 0, pinned, chosen: pinned ?? [], loading: `Loading providers for ${model.id}…` });
      try {
        const routes = await rt.catalog.routes(state.provider, model.id);
        const routeIndex = Math.max(0, routes.findIndex((r) => r.name === pinned?.[0]));
        setPicker((p) => (p ? { ...p, routes, routeIndex, loading: undefined } : p));
      } catch (e) {
        setPicker((p) => (p ? { ...p, loading: undefined, error: (e as Error).message } : p));
      }
    },
    [rt],
  );

  /** Apply the highlighted model, optionally pinning an upstream provider. */
  const applyPick = useCallback(
    (state: PickerState, upstream?: string[]) => {
      const model = filterModels(state.models, state.query)[state.index];
      setPicker(null);
      if (!model) return;
      try {
        rt.setModel(`${state.provider}:${model.id}`);
        updateUserSettings({ model: rt.model.id });
        if (upstream) rt.setRoute(upstream);
        const route = rt.registry.route(rt.model);
        store.contextWindow = rt.registry.info(rt.model).contextWindow;
        pushInfo(`Model: ${rt.model.id}${route ? ` via ${route.join(', ')}` : ''} (saved as default)`);
      } catch (e) {
        store.push({ kind: 'error', text: (e as Error).message });
        store.changed();
      }
    },
    [rt, store, pushInfo],
  );

  /** Copy the last assistant answer (or the last console entry) to the clipboard. */
  const copyLast = useCallback(() => {
    const entry = [...store.entries].reverse().find((e) => e.kind === 'assistant' || e.kind === 'info' || e.kind === 'plan' || e.kind === 'diff' || e.kind === 'error');
    const text = entry && 'text' in entry ? entry.text : '';
    if (!text.trim()) {
      pushInfo('Nothing to copy yet.');
      return;
    }
    const ok = copyToClipboard(text, stdout);
    pushInfo(ok ? `Copied ${text.length} characters to the clipboard.` : 'Could not reach a clipboard tool.');
  }, [store, pushInfo, stdout]);

  const openResume = useCallback(() => {
    const sessions = resumeList(rt);
    if (!sessions.length) {
      pushInfo('No saved sessions for this project yet.');
      return;
    }
    setSessionPicker({ sessions, query: '', index: 0, current: rt.session.id });
  }, [rt, pushInfo]);

  /** Continue the chosen session: history and the file being appended to both switch over. */
  const resumeSession = useCallback(
    (file: string) => {
      setSessionPicker(null);
      const { id, messages } = rt.resumeSession(file);
      // Inline output already sits in the terminal; wipe it so the resumed session reads cleanly.
      clearScreen();
      store.reset();
      store.contextTokens = rt.main.contextTokens;
      store.refreshContext();
      pushInfo(`Resumed session ${id.slice(0, 8)} — ${messages} messages restored. New turns continue this session.`);
      replayTranscript(rt, store);
      store.changed();
    },
    [rt, store, pushInfo],
  );

  const runTests = useCallback(async () => {
    const cmd = detectTestCommand(rt.cwd);
    if (!cmd) {
      pushInfo('No test command detected (package.json test script, cargo, pytest).');
      return;
    }
    pushInfo(`Running ${cmd} …`);
    const r = await runShell(rt, cmd, { timeout: 300_000, trackCwd: false });
    const { parseTestOutput } = await import('./stages.js');
    const stats = parseTestOutput(r.output);
    if (stats) {
      store.stages.tests = { ...store.stages.tests, ...stats };
      store.log(`tests ${stats.passed}/${stats.total}`, stats.failed ? C.red : C.green);
    }
    store.push({ kind: 'info', text: r.output.split('\n').slice(-25).join('\n'), title: `$ ${cmd}` });
    store.changed();
  }, [rt, store, pushInfo]);

  /** Wheel up scrolls back through the transcript, one line per notch. */
  const onWheel = useCallback(
    (wheel: number) => {
      if (!wheel) return;
      if (dialog || picker || sessionPicker || help !== null) return;
      setScroll((v) => Math.max(0, v + wheel));
    },
    [dialog, picker, sessionPicker, help],
  );

  /** Mouse reporting steals drag-selection, so it has to be one keystroke away. */
  const toggleMouse = useCallback(() => {
    const on = setMouse(!mouseOn);
    setMouseOn(on);
    pushInfo(
      on
        ? 'Mouse wheel scrolling ON — drag-select needs shift (option in iTerm2).'
        : 'Mouse wheel scrolling OFF — select and copy with the mouse as usual. PgUp/PgDn still scroll.',
    );
  }, [mouseOn, setMouse, pushInfo]);

  const interrupt = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      store.status = { state: 'idle', detail: 'interrupting' };
      store.changed();
    }
  }, [store]);
  store.interrupt = interrupt;

  const suggestions = useMemo<Suggestion[]>(() => {
    const upToCursor = input.slice(0, cursor);
    if (/^\/\S*$/.test(input.trim()) && !input.includes(' ')) {
      const q = input.slice(1).toLowerCase();
      return listSlashCommands(rt)
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 8)
        .map((c) => ({ value: `/${c.name} `, label: `/${c.name}${c.hint ? ' ' + c.hint : ''}`, hint: c.description }));
    }
    const at = upToCursor.match(/(^|\s)@([^\s]*)$/);
    if (at) {
      if (!filesRef.current) {
        filesRef.current = [];
        fg('**/*', { cwd: rt.cwd, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/target/**'], onlyFiles: true, dot: false, suppressErrors: true })
          .then((f) => {
            filesRef.current = f.slice(0, 20000);
            force((n) => n + 1);
          })
          .catch(() => {});
      }
      const q = at[2].toLowerCase();
      return (filesRef.current ?? [])
        .filter((f) => f.toLowerCase().includes(q))
        .slice(0, 8)
        .map((f) => ({ value: f, label: f, hint: '' }));
    }
    return [];
  }, [input, cursor, rt]);

  useEffect(() => setSuggestIdx(0), [input]);

  const applySuggestion = useCallback(
    (s: Suggestion) => {
      if (input.trim().startsWith('/') && !input.includes(' ')) {
        setInput(s.value);
        setCursor(s.value.length);
        return;
      }
      const before = input.slice(0, cursor).replace(/@[^\s]*$/, '@' + s.value + ' ');
      const next = before + input.slice(cursor);
      setInput(next);
      setCursor(before.length);
    },
    [input, cursor],
  );

  // F-keys and other raw sequences Ink does not surface.
  useEffect(() => {
    const emitter = stdin.internal_eventEmitter;
    if (!emitter) return;
    const onRaw = (raw: string) => {
      // Mouse reports are handled in useInput, which receives them parsed; ignore them here.
      if (wheelDelta(raw).isMouse) return;
      const key = F_KEYS[raw];
      if (!key) return;
      if (key === 'f2') void showDiff();
      else if (key === 'f3') void runTests();
      else if (key === 'f4') void handleSubmit('/phases');
      else if (key === 'f5') {
        const stage = [...store.stages.stages].reverse().find((s) => s.lastCommand);
        if (stage?.lastCommand) void handleSubmit(`Re-run \`${stage.lastCommand}\` and fix whatever fails.`);
        else pushInfo('No stage command to re-run yet.');
      } else if (key === 'f6' && dialog) dialog.resolve(dialog.options[0]?.value ?? '');
      else if (key === 'f7') toggleMouse();
      else if (key === 'f1') setHelp((h) => (h === null ? 0 : null));
    };
    emitter.on('input', onRaw);
    return () => emitter.off('input', onRaw);
  }, [stdin, dialog, onWheel, toggleMouse, handleSubmit, showDiff, runTests, pushInfo, rt, store]);

  useInput((ch, key) => {
    // Ink also hands mouse reports to useInput; swallow them so they never land in the input line.
    const mouseReport = wheelDelta(ch);
    if (mouseReport.isMouse) {
      onWheel(mouseReport.wheel);
      return;
    }
    if (sessionPicker) {
      const p = sessionPicker;
      const list = filterSessions(p.sessions, p.query);
      if (key.escape) return setSessionPicker(null);
      if (key.upArrow) return setSessionPicker({ ...p, index: Math.max(0, p.index - 1) });
      if (key.downArrow) return setSessionPicker({ ...p, index: Math.min(Math.max(0, list.length - 1), p.index + 1) });
      if (key.pageUp) return setSessionPicker({ ...p, index: Math.max(0, p.index - 10) });
      if (key.pageDown) return setSessionPicker({ ...p, index: Math.min(Math.max(0, list.length - 1), p.index + 10) });
      if (key.return) {
        const picked = list[p.index];
        if (picked) resumeSession(picked.file);
        else setSessionPicker(null);
        return;
      }
      if (key.backspace || key.delete) return setSessionPicker({ ...p, query: p.query.slice(0, -1), index: 0 });
      if (ch && !key.ctrl && !key.meta) return setSessionPicker({ ...p, query: p.query + ch, index: 0 });
      return;
    }
    if (help !== null) {
      const page = Math.max(3, helpHeight - 2);
      if (key.escape || ch === '?' || key.return) return setHelp(null);
      if (key.downArrow) return setHelp((h) => (h ?? 0) + 1);
      if (key.upArrow) return setHelp((h) => Math.max(0, (h ?? 0) - 1));
      if (key.pageDown) return setHelp((h) => (h ?? 0) + page);
      if (key.pageUp) return setHelp((h) => Math.max(0, (h ?? 0) - page));
      if (key.ctrl && ch === 'c') return setHelp(null);
      return;
    }
    if (picker) {
      const p = picker;
      const models = filterModels(p.models, p.query);
      const len = p.pane === 'models' ? models.length : p.routes.length;
      const move = (d: number) => {
        if (!len) return;
        if (p.pane === 'models') {
          const index = Math.min(Math.max(0, p.index + d), len - 1);
          const m = models[index];
          const ref = { provider: p.provider, model: m.id, id: `${p.provider}:${m.id}` };
          setPicker({ ...p, index, pinned: rt.registry.route(ref) });
        } else setPicker({ ...p, routeIndex: Math.min(Math.max(0, p.routeIndex + d), len - 1) });
      };
      if (key.escape) {
        if (p.pane === 'routes') return setPicker({ ...p, pane: 'models', error: undefined });
        return setPicker(null);
      }
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);
      if (key.pageUp) return move(-10);
      if (key.pageDown) return move(10);
      if (key.rightArrow && p.pane === 'models') return void openRoutes(p);
      if (key.leftArrow && p.pane === 'routes') return setPicker({ ...p, pane: 'models', error: undefined });
      if (key.tab && p.pane === 'models') {
        const next = p.providers[(p.providers.indexOf(p.provider) + 1) % p.providers.length];
        return void openModelPicker(next);
      }
      if (key.ctrl && ch === 'r') return void openModelPicker(p.provider, true);
      if (key.return) {
        if (p.pane !== 'routes') return applyPick(p);
        const order = p.chosen.length ? p.chosen : p.routes[p.routeIndex] ? [p.routes[p.routeIndex].name] : [];
        return applyPick(p, order);
      }
      if (p.pane === 'routes' && ch === ' ') {
        const name = p.routes[p.routeIndex]?.name;
        if (!name) return;
        const chosen = p.chosen.includes(name) ? p.chosen.filter((c) => c !== name) : [...p.chosen, name];
        return setPicker({ ...p, chosen });
      }
      if (p.pane === 'routes' && ch === 'a') return applyPick(p, []);
      if (p.pane === 'models') {
        if (key.backspace || key.delete) return setPicker({ ...p, query: p.query.slice(0, -1), index: 0 });
        if (ch && !key.ctrl && !key.meta) return setPicker({ ...p, query: p.query + ch, index: 0 });
      }
      return;
    }
    if (dialog) {
      if (dialog.text) {
        if (key.return) {
          const d = dialog;
          setDialog(null);
          d.resolve('__text__', d.text!.value);
          return;
        }
        if (key.escape) {
          setDialog({ ...dialog, text: undefined });
          return;
        }
        if (key.backspace || key.delete) {
          setDialog({ ...dialog, text: { ...dialog.text, value: dialog.text.value.slice(0, -1) } });
          return;
        }
        if (ch && !key.ctrl && !key.meta) setDialog({ ...dialog, text: { ...dialog.text, value: dialog.text.value + ch } });
        return;
      }
      if (key.upArrow) return setDialog({ ...dialog, selected: (dialog.selected - 1 + dialog.options.length) % dialog.options.length });
      if (key.downArrow || key.tab) return setDialog({ ...dialog, selected: (dialog.selected + 1) % dialog.options.length });
      if (/^[1-9]$/.test(ch)) {
        const i = Number(ch) - 1;
        if (i < dialog.options.length) {
          const d = dialog;
          setDialog(null);
          d.resolve(d.options[i].value);
        }
        return;
      }
      if (key.return) {
        const d = dialog;
        const opt = d.options[d.selected];
        if (opt.value === '__text__') return setDialog({ ...d, text: { prompt: 'Type your answer:', value: '' } });
        setDialog(null);
        d.resolve(opt.value);
        return;
      }
      if (key.escape) {
        const d = dialog;
        setDialog(null);
        d.resolve('__escape__');
        return;
      }
      return;
    }

    if (key.ctrl && ch === 'c') {
      // cmd+C never reaches the app — the terminal copies the selection itself — so ctrl+C keeps
      // its usual job: stop the run, clear the line, then exit on a second press.
      if (busyRef.current) return interrupt();
      if (input) {
        setInput('');
        setCursor(0);
        return;
      }
      if (exitArmed) return exit();
      setExitArmed(true);
      setTimeout(() => setExitArmed(false), 2000);
      return;
    }
    if (key.ctrl && ch === 'd' && !input) return exit();
    if (key.escape) {
      if (busyRef.current) return interrupt();
      if (input) {
        setInput('');
        setCursor(0);
      }
      return;
    }
    if (key.ctrl && ch === 'o') {
      store.expanded = !store.expanded;
      store.changed();
      return;
    }
    if (key.ctrl && ch === 'b') {
      onLayout(!inline);
      return;
    }
    if (key.ctrl && ch === 'y') {
      copyLast();
      return;
    }
    if (key.ctrl && ch === 'r') {
      const stage = [...store.stages.stages].reverse().find((s) => s.lastCommand);
      if (stage?.lastCommand) void handleSubmit(`Re-run \`${stage.lastCommand}\` and fix whatever fails.`);
      return;
    }
    if (key.tab && key.shift) {
      const next = MODES[(MODES.indexOf(rt.mode) + 1) % MODES.length];
      rt.setMode(next);
      store.changed();
      return;
    }

    if (process.env.ALTERAN_DEBUG_KEYS) process.stderr.write(`KEY ${JSON.stringify(ch)} ${JSON.stringify(Object.keys(key).filter(k=>(key as any)[k]===true))} input=${JSON.stringify(input)} sugg=${suggestions.length}\n`);
    if (suggestions.length) {
      if (key.upArrow) return setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
      if (key.downArrow) return setSuggestIdx((i) => (i + 1) % suggestions.length);
      const sel = suggestions[suggestIdx];
      const isSlashPrefix = input.trim().startsWith('/') && !input.includes(' ');
      const exact = isSlashPrefix && sel && sel.value.trim() === input.trim();
      if (sel && (key.tab || (key.return && isSlashPrefix && !exact))) {
        applySuggestion(sel);
        return;
      }
    }

    if (key.return) {
      if (key.meta || input.endsWith('\\')) {
        const next = (input.endsWith('\\') ? input.slice(0, -1) : input) + '\n';
        setInput(next);
        setCursor(next.length);
        return;
      }
      const text = input;
      setInput('');
      setCursor(0);
      void handleSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput(input.slice(0, cursor - 1) + input.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }
    if (key.leftArrow) return setCursor(Math.max(0, cursor - (key.meta ? 5 : 1)));
    if (key.rightArrow) return setCursor(Math.min(input.length, cursor + (key.meta ? 5 : 1)));
    if (key.ctrl && ch === 'a') return setCursor(0);
    if (key.ctrl && ch === 'e') return setCursor(input.length);
    if (key.ctrl && ch === 'u') {
      setInput(input.slice(cursor));
      setCursor(0);
      return;
    }
    if (key.pageUp) return setScroll((s) => s + 10);
    if (key.pageDown) return setScroll((s) => Math.max(0, s - 10));
    if (key.ctrl && ch === 'k') return setInput(input.slice(0, cursor));
    if (key.ctrl && ch === 'w') {
      const before = input.slice(0, cursor).replace(/\S*\s*$/, '');
      setInput(before + input.slice(cursor));
      setCursor(before.length);
      return;
    }
    if (key.upArrow && !input.includes('\n')) {
      const i = Math.min(history.length - 1, histIdx + 1);
      if (i >= 0) {
        setHistIdx(i);
        setInput(history[i]);
        setCursor(history[i].length);
      }
      return;
    }
    if (key.downArrow && !input.includes('\n')) {
      const i = histIdx - 1;
      setHistIdx(i);
      const v = i >= 0 ? history[i] : '';
      setInput(v);
      setCursor(v.length);
      return;
    }
    if (ch === '?' && !input) {
      setHelp((h) => (h === null ? 0 : null));
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      const text = ch.replace(/\r/g, '\n');
      setInput(input.slice(0, cursor) + text + input.slice(cursor));
      setCursor(cursor + text.length);
    }
  });

  useEffect(() => {
    if (pickResume) openResume();
    if (initialPrompt) void handleSubmit(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickerHeight = Math.max(14, Math.min(26, bodyHeight - 8));
  const helpHeight = Math.max(10, Math.min(28, bodyHeight - 6));
  const sessionHeight = Math.max(12, Math.min(24, bodyHeight - 8));
  const inputAreaHeight = sessionPicker
    ? sessionHeight
    : help !== null
    ? helpHeight
    : picker
    ? pickerHeight
    : dialog
      ? Math.min(14, 6 + dialog.options.length + dialog.body.length)
      : 3 + Math.min(7, input.split('\n').length - 1) + (queue.length ? 1 : 0);
  const suggestionHeight = suggestions.length && !dialog && !picker && !sessionPicker && help === null ? suggestions.length : 0;

  const overlay = sessionPicker ? (
    <SessionPickerView state={sessionPicker} width={consoleWidth} height={sessionHeight} />
  ) : help !== null ? (
    <HelpPanel text={helpText(rt)} width={consoleWidth} height={helpHeight} scroll={help} />
  ) : picker ? (
    <ModelPickerView state={picker} width={consoleWidth} height={pickerHeight} />
  ) : dialog ? (
    <DialogView state={dialog} width={consoleWidth} />
  ) : null;

  const prompt = (
    <>
      {suggestions.length ? <SuggestionList items={suggestions} selected={suggestIdx} width={consoleWidth} /> : null}
      <InputBox
        value={input}
        cursor={cursor}
        width={consoleWidth}
        queued={queue.length}
        mode={rt.mode}
        placeholder={exitArmed ? 'press ctrl+c again to exit' : store.running ? 'type to queue a follow-up…' : 'what should alteran do? (/ for commands, @ for files)'}
      />
      <Lines
        lines={[
          [
            seg('? shortcuts', C.muted),
            seg(
              `  ^Y copy answer  ^B ${inline ? 'panels on' : 'console only'}${inline ? '' : `  F7 mouse ${mouseOn ? 'on' : 'off'}`}  ^C abort  ^O expand  shift+tab mode  F2 diff  F3 tests`,
              C.dim,
            ),
          ],
        ]}
      />
    </>
  );

  if (inline) {
    // Everything above the prompt is plain terminal output: the wheel and text selection are the
    // terminal's own, exactly as in a normal shell session.
    return (
      <Box flexDirection="column" width={width}>
        <StaticTranscript key={store.generation} store={store} width={consoleWidth} />
        <Box flexDirection="column" paddingX={2}>
          <LiveTail store={store} width={consoleWidth} maxHeight={Math.max(4, height - 12)} />
          <StatusLine store={store} width={consoleWidth} />
          {overlay ?? prompt}
          <InlineStatus store={store} rt={rt} width={consoleWidth} />
        </Box>
      </Box>
    );
  }

  const streamHeight = Math.max(3, bodyHeight - inputAreaHeight - suggestionHeight - 2);
  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={C.bg}>
      <Box paddingX={1} flexDirection="column">
        <TopBar store={store} rt={rt} width={width - 2} />
      </Box>
      <Box flexDirection="row" height={bodyHeight}>
        {showLeft ? (
          <>
            <GatePanel store={store} width={LEFT_WIDTH} height={bodyHeight} />
            <Divider height={bodyHeight} />
          </>
        ) : null}
        <Box flexDirection="column" flexGrow={1} paddingX={2} height={bodyHeight} backgroundColor={C.bg}>
          <StreamView store={store} width={consoleWidth} height={streamHeight} scroll={scroll} />
          <StatusLine store={store} width={consoleWidth} />
          {overlay ?? prompt}
        </Box>
        {showRight ? (
          <>
            <Divider height={bodyHeight} />
            <SystemsPanel store={store} rt={rt} width={RIGHT_WIDTH} height={bodyHeight} />
          </>
        ) : null}
      </Box>
      <Box paddingX={1} flexDirection="column">
        <StatusBar store={store} rt={rt} width={width - 2} />
      </Box>
    </Box>
  );
}

function detectTestCommand(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg.scripts?.test) return fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm test' : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn test' : 'npm test';
  } catch {}
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) return 'pytest -q';
  return undefined;
}

function helpText(rt: Runtime): string {
  const cmds = listSlashCommands(rt);
  const builtin = cmds.filter((c) => c.origin === 'builtin');
  const custom = cmds.filter((c) => c.origin !== 'builtin');
  const fmt = (c: { name: string; hint?: string; description: string }) => `  /${(c.name + (c.hint ? ' ' + c.hint : '')).padEnd(34)} ${c.description.slice(0, 70)}`;
  return [
    'Commands:',
    ...builtin.map(fmt),
    custom.length ? `\nFrom plugins, Claude Code, Codex and skills (${custom.length}):` : '',
    ...custom.slice(0, 25).map(fmt),
    '',
    'Keys:',
    '  enter submit   \\+enter or alt+enter newline   esc interrupt / clear',
    '  shift+tab cycle permission mode   ctrl+o expand tool output   ctrl+r rerun last stage command',
    '  ctrl+b side panels on/off — the console-only default keeps mouse selection to console text',
    '  wheel scrolls the transcript; F7 (or /mouse) turns mouse reporting off so drag-select works again',
    '  ctrl+y copy the last answer to the clipboard (cmd+c still copies a mouse selection)',
    '  pgup/pgdn scroll   ctrl+c interrupt or exit   ctrl+d exit',
    '  F2 diff   F3 run tests   F4 phases   F5 rerun stage   F6 approve pending permission',
    '',
    'Model picker (/model): type to filter, -> providers and prices for the model, enter to use,',
    '  tab switches provider, ^R refreshes the catalog, "a" restores automatic routing.',
    '',
    'Workflow: /plan → approve → tasks are created in CONSILIUM → /run-phase 1 → /run-phase 2 …',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export async function startTui(opts: TuiOptions, io?: TuiIo): Promise<void> {
  const dialogRef: React.MutableRefObject<((d: DialogState | null) => void) | null> = { current: null };
  const instanceRef: { current: (() => void) | null } = { current: null };
  const clearRef: { current: (() => void) | null } = { current: null };
  const setDialog = (d: DialogState | null) => dialogRef.current?.(d);

  const ask = <T,>(make: (resolve: (value: string, text?: string) => void) => DialogState, map: (value: string, text?: string) => T, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const state = make((value, text) => resolve(map(value, text)));
      setDialog(state);
      signal?.addEventListener(
        'abort',
        () => {
          setDialog(null);
          reject(new InterruptedError());
        },
        { once: true },
      );
    });

  const ui: UIBridge = {
    async askPermission(req: PermissionRequest, signal): Promise<PermissionAnswer> {
      store.awaiting = true;
      store.changed();
      try {
        return await ask<PermissionAnswer>(
          (resolve) => ({
            title: 'IRIS — PERMISSION REQUIRED',
            body: [
              [seg(`${req.agentLabel} wants to use `, C.muted), seg(req.tool, C.gold, { bold: true })],
              [seg(truncate(req.summary || JSON.stringify(req.input), 400), C.text)],
              ...(req.reason ? [[seg(req.reason, C.muted)]] : []),
            ],
            options: [
              { value: 'once', label: 'Yes, once' },
              ...(req.suggestion ? [{ value: 'always', label: `Yes, and allow ${req.suggestion} for this session` }] : []),
              { value: '__text__', label: 'No, and tell alteran what to do differently' },
              { value: 'no', label: 'No (esc)' },
            ],
            selected: 0,
            resolve,
          }),
          (value, text): PermissionAnswer => {
            if (value === 'once') return { kind: 'allow_once' };
            if (value === 'always' && req.suggestion) return { kind: 'allow_always', rule: req.suggestion };
            return { kind: 'deny', feedback: text };
          },
          signal,
        );
      } finally {
        store.awaiting = false;
        store.changed();
      }
    },
    async askQuestions(questions: AskQuestions, signal) {
      const answers: Record<string, string> = {};
      store.awaiting = true;
      store.changed();
      try {
        for (const q of questions) {
          answers[q.question] = await ask<string>(
            (resolve) => ({
              title: q.header ? `QUESTION — ${q.header.toUpperCase()}` : 'QUESTION',
              body: [[seg(q.question, C.text)]],
              options: [...q.options.map((o) => ({ value: o.label, label: o.label, hint: o.description })), { value: '__text__', label: 'Other (type your own)' }],
              selected: 0,
              resolve,
            }),
            (value, text) => (value === '__text__' || value === '__escape__' ? text ?? '(no answer)' : value),
            signal,
          );
        }
        return answers;
      } finally {
        store.awaiting = false;
        store.changed();
      }
    },
    async reviewPlan(plan, signal): Promise<PlanDecision> {
      store.awaiting = true;
      store.changed();
      try {
        return await ask<PlanDecision>(
          (resolve) => ({
            title: 'PLAN READY — APPROVE?',
            body: [[seg('The plan is shown above. Approving with task creation runs the create-tasks agent.', C.muted)]],
            options: [
              { value: 'tasks', label: 'Approve and create phased tasks in CONSILIUM', hint: 'recommended' },
              { value: 'auto', label: 'Approve and start implementing (auto-accept edits)' },
              { value: 'manual', label: 'Approve and start implementing (ask before edits)' },
              { value: '__text__', label: 'Keep planning — give feedback' },
            ],
            selected: 0,
            resolve,
          }),
          (value, text): PlanDecision => {
            if (value === 'tasks') return { kind: 'tasks', mode: 'default' };
            if (value === 'auto') return { kind: 'approve', mode: 'acceptEdits' };
            if (value === 'manual') return { kind: 'approve', mode: 'default' };
            return { kind: 'feedback', text: text || 'Keep planning; refine the plan.' };
          },
          signal,
        );
      } finally {
        store.awaiting = false;
        store.changed();
      }
    },
  };

  applyTheme((process.env.ALTERAN_THEME as ThemeName | undefined) ?? undefined);
  const booting = Runtime.create({
    cwd: opts.cwd,
    model: opts.model,
    mode: opts.mode,
    reasoning: opts.reasoning,
    resume: opts.resume,
    ui,
    noMcp: opts.mcp === false,
  });
  // Loading settings, extensions and MCP takes a second or two; dial the gate through it.
  const intro = opts.intro ?? (io ? undefined : startIntro(opts.cwd));
  if (intro) {
    intro.release(booting);
    await intro.done;
  }
  const rt = await booting;
  applyTheme((process.env.ALTERAN_THEME as ThemeName | undefined) ?? (rt.settings.theme as ThemeName | undefined));
  const store = new UiStore(rt);
  for (const e of rt.settingsErrors) store.push({ kind: 'notice', level: 'warn', text: `settings: ${e}`, t: 0 });
  const route = rt.registry.route(rt.model);
  store.push({
    kind: 'splash',
    rows: [
      ['model', `${rt.model.id}${route ? `  via ${route.join(', ')}` : ''}`],
      ['mode', rt.mode],
      ['project', rt.root.replace(process.env.HOME ?? '~', '~')],
      ['loaded', `${rt.ext.agents.size} agents · ${rt.ext.skills.size} skills · ${rt.ext.plugins.length} plugins · ${rt.ext.mcpServers.size} MCP`],
      ['tracker', rt.tracker ? `${rt.tracker.all().length} issues (${rt.tracker.prefix}-*)` : 'not initialized — start with /plan'],
    ],
    hints: [
      'Type a task, or /help for commands.',
      '/plan → approve → /run-phase 1 delivers the work phase by phase.',
      '^B panels   ^Y copy answer   ^C interrupt',
    ],
  });

  // A session started with --continue/--resume must look continued, not empty.
  if (rt.resumedId) {
    store.push({
      kind: 'info',
      text: `Resumed session ${rt.resumedId.slice(0, 8)} — ${rt.main.messages.length} messages restored. New turns continue this session.`,
    });
    replayTranscript(rt, store);
    store.contextTokens = rt.main.contextTokens;
    store.refreshContext();
  } else if (typeof opts.resume === 'string' && opts.resume !== 'last') {
    store.push({ kind: 'error', text: `No session in this project starts with "${opts.resume}". Run \`alteran sessions\` to see them.` });
  } else if (opts.resume === 'last') {
    store.push({ kind: 'error', text: 'No saved session to continue in this project yet.' });
  }

  // Wheel reporting (SGR mouse mode). Terminals route the wheel to the app once this is on;
  // drag-selection still works with shift (iTerm2: option) held, and `"mouse": false` opts out.
  const out = io?.stdout ?? process.stdout;
  const setMouse = (on: boolean): boolean => {
    try {
      out.write(on ? '\u001b[?1000h\u001b[?1006h' : '\u001b[?1006l\u001b[?1000l');
      return on;
    } catch {
      return false;
    }
  };
  if (!io)
    process.once('exit', () => {
      setMouse(false);
      printResumeHint(rt, process.stdout);
    });

  let mcpStarted = false;
  // The two layouts need different terminal modes, so switching remounts. The store survives,
  // which is what carries the conversation across the switch.
  let inline = rt.settings.panels !== true;
  for (;;) {
    let next: boolean | null = null;
    // Panels need the alternate screen, and only there is wheel reporting worth its cost:
    // inline output is scrolled and selected by the terminal itself.
    if (!inline && rt.settings.mouse !== false) setMouse(true);
    const instance = render(
      <App
        rt={rt}
        store={store}
        setMouse={setMouse}
        inline={inline}
        onLayout={(v) => {
          next = v;
          instanceRef.current?.();
        }}
        clearScreen={() => clearRef.current?.()}
        dialogRef={dialogRef}
        initialPrompt={mcpStarted ? undefined : opts.prompt}
        pickResume={mcpStarted ? false : opts.pickResume}
      />,
      {
        exitOnCtrlC: false,
        alternateScreen: !io && !inline,
        incrementalRendering: !io,
        ...(io ? { stdin: io.stdin, stdout: io.stdout, patchConsole: false } : {}),
      },
    );
    instanceRef.current = () => instance.unmount();
    clearRef.current = () => instance.clear();

    if (!mcpStarted && opts.mcp !== false && rt.mcp.servers.size) {
      void rt.connectMcp().then(() => {
        const failed = [...rt.mcp.servers.values()].filter((s) => s.status !== 'connected');
        if (failed.length) store.log(`${failed.length} MCP server(s) failed`, C.amber);
        store.changed();
      });
    }
    mcpStarted = true;

    await instance.waitUntilExit();
    setMouse(false);
    const chosen = next as boolean | null;
    if (chosen === null) break;
    inline = chosen;
    // Entries already flushed to the terminal are gone from Ink's view; redraw them in the new
    // layout by replaying the transcript from the store.
    store.staticCount = 0;
  }
  store.dispose();
  await rt.shutdown();
  // Ink restores the main screen on unmount; printing on the next macrotask keeps the hint
  // from being wiped along with the alternate screen buffer.
  await new Promise((r) => setTimeout(r, 30));
  printResumeHint(rt, io?.stdout ?? process.stdout);
  // MCP servers, background shells and sockets can keep the loop alive after teardown; the shell
  // prompt must come back immediately, so leave deliberately once the output is flushed.
  if (!io) {
    await new Promise<void>((r) => {
      process.stdout.write('', () => r());
      setTimeout(r, 200);
    });
    process.exit(0);
  }
}

/** Replay a resumed conversation into the console, minus the tool-call noise. */
function replayTranscript(rt: Runtime, store: UiStore) {
  for (const m of rt.main.messages) {
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();
    if (!text || text.startsWith('<system-reminder>')) continue;
    store.push(m.role === 'user' ? { kind: 'user', text, t: 0 } : { kind: 'assistant', text, t: 0 });
  }
}

/** Printed at most once per runtime, so the normal exit and the exit hook do not both fire. */
const hinted = new WeakSet<Runtime>();

/** How to get back into this work. Runs once, whichever way the session ended. */
function printResumeHint(rt: Runtime, out: NodeJS.WriteStream) {
  if (hinted.has(rt)) return;
  hinted.add(rt);
  const saved = rt.main.messages.length > 0;
  const id = rt.session.id.slice(0, 8);
  const others = SessionStore.list(rt.root).filter((s) => s.id !== rt.session.id).length;
  if (!saved && !others) return;
  // Commands go on their own line, unquoted, so they can be copied with one double-click.
  const cmd = (command: string, note: string) => `  ${paint.gold(command.padEnd(28))}${paint.dim(note)}`;
  const lines = [
    saved ? paint.muted(`Session ${id} saved — ${rt.main.messages.length} messages.`) : paint.muted('Nothing was sent in this session.'),
    '',
    saved ? cmd(`alteran --resume ${id}`, 'continue this session') : '',
    others ? cmd('alteran --resume', `pick from ${others} older session${others === 1 ? '' : 's'}`) : '',
    cmd('alteran sessions', 'list every session of this project'),
  ].filter(Boolean);
  try {
    out.write('\n' + lines.join('\n') + '\n');
  } catch {
    /* the stream may already be closed on a hard exit */
  }
}
