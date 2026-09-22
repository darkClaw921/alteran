# ALTERAN.md

Guidance for agents working in this repository (`alteran` — the terminal coding agent).

## Commands

```bash
pnpm dev -- -p "prompt"        # run the CLI from source (tsx)
pnpm build                     # tsup → dist/cli.js, dist/abr.js
pnpm typecheck                 # tsc --noEmit (TypeScript 7)
pnpm test                      # vitest, all suites
npx vitest run test/tracker.test.ts -t "ready"   # single suite / single test
node_modules/.bin/tsx scripts/preview.tsx        # static render of the full TUI (no TTY needed)
node_modules/.bin/tsx scripts/drive.ts           # drive the TUI through the fake-TTY harness
node_modules/.bin/tsx scripts/contrast.ts        # audit rendered colours against the background
node_modules/.bin/tsx scripts/pickmodel.ts       # drive /model against the real provider catalog
node_modules/.bin/tsx scripts/bare.ts            # render the console-only layout
node_modules/.bin/tsx scripts/panelcheck.ts      # render the ASTRIA PORTA panel at full width
node_modules/.bin/tsx scripts/promptsize.ts      # token estimate of every system-prompt block
node_modules/.bin/tsx scripts/promptblocks.ts    # print the catalogs exactly as the model sees them
node_modules/.bin/tsx scripts/introcheck.ts      # print frames of the boot animation
node_modules/.bin/tsx scripts/inlinecheck.ts     # prove inline output is written once, never redrawn
node_modules/.bin/tsx scripts/idlecheck.ts       # prove the console writes nothing while idle
```

## Architecture

Single package, ESM, Node ≥ 22.5. Entry points: `src/cli.ts` (commander; TUI, headless `-p`, `tasks`, `mcp`, `doctor`, …) and `src/abr.ts` (tracker CLI alias).

- `src/types.ts` — provider-neutral message model (`ContentBlock`, `Message`, `StreamEvent`, `Usage`). Everything else speaks this shape.
- `src/providers/` — `anthropic.ts` (adaptive thinking, prompt caching, eager tool streaming), `openai-responses.ts` (Responses API, reasoning items carried back as `opaque` blocks), `openai-compat.ts` (Chat Completions for OpenRouter / polza.ai / Ollama / LM Studio), `registry.ts` (provider configs, `provider:model` resolution, context windows, pinned gateway routes), `catalog.ts` (model lists with pricing, upstream providers per model, key balance; disk-cached for 6h under `~/.alteran/cache/`).
- `src/core/` — `agent.ts` is the loop: stream → tool_use → hooks → permissions → execute (read-only calls run in parallel) → tool_result → repeat, plus compaction; `runtime.ts` wires settings, extensions, permissions, hooks, MCP, tracker, session and subagents; `commands.ts` implements slash commands; `prompt.ts` builds system prompts; `session.ts` persists transcripts under `~/.alteran/sessions/<project>/`.
- `src/tools/` — Read/Write/Edit/MultiEdit/Glob/Grep/Bash(+background)/WebFetch/TodoWrite/AskUserQuestion/ExitPlanMode/Task/Skill/ToolSearch and MCP resource tools. A tool declares a zod schema, a category (`read|write|bash|network|meta|mcp|tasks`) and `readOnly`; `readOnly` drives both parallel execution and auto-approval.
- `src/tracker/` — the CONSILIUM tracker. `store.ts` owns `.beads/issues.jsonl` (in-memory index + atomic writes under a lock file), `model.ts` mirrors the beads record shape and field order, `cli.ts` is the `br`-compatible command surface, `tools.ts` exposes `tasks_*` to the model.
- `src/permissions/` — Claude-style rule parsing/matching and the decision matrix; `src/hooks/` — Claude-compatible command hooks.
- `src/compat/loader.ts` — discovers agents, commands, skills, plugins, MCP servers, hooks, permission rules and instruction files across Claude Code, Codex, `~/.agents`, Cursor, Gemini and native `.alteran` locations.
- Gateway routing: `settings.routes["provider:model"]` is sent as `provider: { order, allow_fallbacks: false }`, so routing stays inside the chosen list, in the chosen order (the routes pane ticks them with `space`). `/model` (right arrow) and `alteran models --routes` show the prices behind that choice; per-request cost comes back in `usage.cost` and accumulates into the session total.
- `src/tui/` — Ink UI. `store.ts` turns bus events into view state, `render.ts` turns entries into styled lines, `gate.ts` draws the procedural stargate, `stages.ts` classifies activity into the nine GRADUS stages, `components/` holds the panels.

## Conventions

- Everything the UI shows comes from `EventBus` events (`src/core/events.ts`) — add an event rather than reaching into the runtime from components.
- Tracker data must stay readable by `br`: keep the field order in `model.ts`, preserve unknown fields, never write a database file.
- The system prompt only carries what the agent can act on: `Runtime.promptCaps()` decides whether the Task agent catalog, the Skills catalog and the tracker section of `assets/prompts/system.md` are included, and catalog descriptions are summarised (examples stripped, one sentence) rather than pasted whole.
- `src/core/context.ts` estimates what fills the window (system / instructions / catalogs / tool schemas / MCP schemas / conversation) at ~3.5 chars per token; only the total is measured, from the provider's prompt tokens. The VIRES meter, `/context` and the headless report all read the same breakdown, and `CONTEXT_COLORS` in `theme.ts` keeps their colours in sync.
- `Runtime.resumeSession(file)` is the single resume path (CLI `--continue`/`--resume`, `/resume`, the picker): it reassigns `rt.session` to the file being continued, so a resumed session keeps one transcript instead of forking into a new one.
- Transient UI (help `?`, the model picker, permission dialogs) replaces the input area rather than being pushed into the transcript — anything appended there scrolls the conversation and cannot be dismissed.
- Animation is start-up only: `GateState.dialing` (set by the splash alone — never by `GatePanel`) turns on the rim pulse, drifting dust and the chevron dial; the resting panel gate is static and work drives it through `active`/`chevrons`. `app.tsx` repaints idle frames at half the 120ms tick and stops at the first user message; `entryLines` keys the splash by tick so every other entry stays cached.
- The gate is drawn in visual space (a cell counts as 1×2), so `gateSize()` picks a box roughly twice as wide as tall and `renderGate` measures the rim with a gradient-corrected distance; filling a wide panel edge to edge would draw a flattened ellipse. A roundness test guards this.
- Palette lives in `src/tui/theme.ts`; every colour must stay ≥3:1 against the panel background (enforced by a test and `scripts/contrast.ts`). Themes: `dark` (default), `contrast`, `design`.
- The console-only layout (the default) renders the transcript through Ink's `<Static>` with the alternate screen off, so finished output becomes ordinary terminal output — the terminal owns scrolling and selection, as in Claude Code. The panel layout keeps the full-screen three-column view on the alternate screen; `ctrl+b` switches, which remounts the app (hence the render loop in `startTui`). `store.settle()`/`store.live()` split entries into "final, already printed" and "still changing"; the splash animates in both layouts until the first user message (nothing is above it to scroll yet) and the console then goes completely still, because any later repaint would drag a scrolled-up terminal back to the bottom, and `store.reset()` bumps a generation that remounts `<Static>`, which otherwise counts what it has already printed and would swallow the first new entry; switching layouts (`ctrl+b`) remounts the app, which is why `startTui` renders in a loop.
- `src/tui/intro.ts` plays the boot animation (dial → kawoosh → travel) on the alternate screen while `Runtime.create` runs, looping the travel frames until it resolves; `settings.intro: false` or `ALTERAN_NO_INTRO=1` skips it.
- The panel layout turns on SGR mouse reporting (`?1000h`/`?1006h`) so the wheel scrolls the transcript one line per notch, and turns it off on exit; `wheelDelta` in `lines.ts` parses the reports and `useInput` swallows them so they never reach the input line. Mouse reporting takes drag-selection away from the terminal, so `F7` / `/mouse` toggles it live (`settings.mouse: false` starts with it off).
- Terminal selection is rectangular across the full screen, so the console-only layout is the default (`bare` state in `app.tsx`, `settings.panels` opts into the side panels, `ctrl+b` toggles) and `ctrl+y` copies the last answer through `src/tui/clipboard.ts` (OSC 52 fallback; `ALTERAN_CLIPBOARD=osc52` skips the helper binaries). `cmd+c` never reaches the process — the terminal copies the selection itself — so `ctrl+c` keeps interrupt/exit.
- Lines are rendered manually (`src/tui/lines.ts`) and Ink only prints them with `wrap="truncate"`; keep wrapping/width logic there, not in components.
- Tests run without network: providers are replaced with a scripted stub (`test/agent.test.ts`), the TUI runs on fake TTY streams (`test/harness.ts`). `test/tracker.test.ts` additionally exercises real `br` interop when the binary is installed.
- Never add `git commit`/`git push` behaviour to agent code paths; the agent must ask the user.
