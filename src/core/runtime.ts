import fs from 'node:fs';
import path from 'node:path';
import { loadExtensions } from '../compat/loader.js';
import type { AgentDef, Extensions } from '../compat/types.js';
import { projectRoot } from '../config/paths.js';
import { loadSettings, updateUserSettings, type PermissionMode, type Settings } from '../config/settings.js';
import { buildHookRunner, type HookRunner } from '../hooks/hooks.js';
import { McpManager } from '../mcp/manager.js';
import { Permissions, type PermissionAnswer, type PermissionRequest } from '../permissions/permissions.js';
import { ProviderRegistry, type ModelRef } from '../providers/registry.js';
import { ModelCatalog } from '../providers/catalog.js';
import { estimateTokens } from './context.js';
import { TrackerStore } from '../tracker/store.js';
import type { BackgroundShell } from '../tools/bash.js';
import { killAllShells } from '../tools/bash.js';
import type { AskQuestions } from '../tools/misc-tools.js';
import { BUILTIN_TOOLS, MAIN_ONLY_TOOLS, TOOL_ALIASES } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import { textOf } from '../types.js';
import { Agent, type AgentHandle } from './agent.js';
import { EventBus } from './events.js';
import { gitSnapshot, mainSystemPrompt, subagentSystemPrompt, type EnvInfo, type PromptCapabilities } from './prompt.js';
import { SessionStore } from './session.js';

export type PlanDecision =
  | { kind: 'approve'; mode?: PermissionMode }
  | { kind: 'tasks'; mode?: PermissionMode }
  | { kind: 'feedback'; text: string };

/** Interactive capabilities supplied by the TUI; absent in headless mode. */
export interface UIBridge {
  askPermission?(req: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  askQuestions?(qs: AskQuestions, signal: AbortSignal): Promise<Record<string, string>>;
  reviewPlan?(plan: string, signal: AbortSignal): Promise<PlanDecision>;
}

export interface RuntimeOptions {
  cwd: string;
  model?: string;
  mode?: PermissionMode;
  reasoning?: Settings['reasoning'];
  resume?: string | 'last';
  ui?: UIBridge;
  /** Skip connecting MCP servers (tests, `alteran tasks`). */
  noMcp?: boolean;
}

export interface SubagentRequest {
  agentType: string;
  description: string;
  prompt: string;
  parent: AgentHandle;
  signal: AbortSignal;
}

const MODE_ALIASES: Record<string, PermissionMode> = {
  bypassPermissions: 'autonomous',
  autonomous: 'autonomous',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  default: 'default',
  dontAsk: 'autonomous',
  auto: 'acceptEdits',
};

export class Runtime {
  cwd: string;
  readonly root: string;
  settings: Settings;
  readonly settingsErrors: string[];
  readonly registry: ProviderRegistry;
  readonly catalog: ModelCatalog;
  readonly ext: Extensions;
  readonly permissions: Permissions;
  readonly hooks: HookRunner;
  readonly bus = new EventBus();
  readonly mcp: McpManager;
  /** Reassigned by `resumeSession`, so turns land in the file being continued. */
  session: SessionStore;
  /** Set when the session was continued (`--continue`, `--resume`), so the UI can replay it. */
  resumedId?: string;
  tracker?: TrackerStore;
  ui?: UIBridge;
  model: ModelRef;
  reasoning: NonNullable<Settings['reasoning']>;
  readonly env: Record<string, string>;
  readonly fileState = new Map<string, number>();
  readonly shells = new Map<string, BackgroundShell>();
  readonly startedAt = Date.now();
  lastPlan?: { text: string; file: string };
  modeBeforePlan?: PermissionMode;
  main!: Agent;
  onCompacted?: (agent: Agent) => void;
  private trackerUnsub?: () => void;

  private constructor(opts: RuntimeOptions) {
    this.cwd = path.resolve(opts.cwd);
    this.root = projectRoot(this.cwd);
    const loaded = loadSettings(this.cwd);
    this.settings = loaded.settings;
    this.settingsErrors = loaded.errors;
    this.ext = loadExtensions({ cwd: this.cwd, root: this.root, settings: this.settings });
    this.env = { ...this.ext.env };
    for (const [k, v] of Object.entries(this.ext.env)) if (process.env[k] === undefined) process.env[k] = v;
    this.registry = new ProviderRegistry(this.settings);
    this.catalog = new ModelCatalog(this.registry);
    this.model = this.registry.resolve(opts.model);
    this.reasoning = opts.reasoning ?? this.settings.reasoning ?? 'high';
    const mode = opts.mode ?? this.settings.permissions?.defaultMode ?? 'default';
    this.permissions = new Permissions(this.ext.rules, mode, this.root);
    this.ui = opts.ui;

    let resumeFile: string | undefined;
    if (opts.resume === 'last') resumeFile = SessionStore.list(this.root)[0]?.file;
    else if (opts.resume) resumeFile = SessionStore.list(this.root).find((s) => s.id.startsWith(opts.resume!))?.file;
    const resumeId = resumeFile ? path.basename(resumeFile, '.jsonl') : undefined;
    this.session = new SessionStore(this.root, { cwd: this.cwd, root: this.root, model: this.model.id }, resumeId);

    this.hooks = buildHookRunner(this.ext.hookSources, {
      sessionId: this.session.id,
      transcriptPath: this.session.file,
      cwd: () => this.cwd,
      projectDir: this.root,
    });
    this.mcp = new McpManager(opts.noMcp ? [] : this.ext.mcpServers.values(), this.cwd);
    const store = TrackerStore.discover(this.cwd);
    if (store) this.attachTracker(store);

    this.main = new Agent({ runtime: this, label: 'alteran', model: this.model, system: this.buildMainSystem() });
    this.main.onMessage = (m) => this.session.append(m);
    if (resumeFile) {
      this.main.messages = SessionStore.load(resumeFile).messages;
      this.main.contextTokens = this.main.messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content)), 0);
      this.resumedId = this.session.id;
    }
    this.onCompacted = (agent) => {
      if (agent === this.main) {
        this.session.reset('compact');
        for (const m of agent.messages) this.session.append(m);
      }
    };
  }

  static async create(opts: RuntimeOptions): Promise<Runtime> {
    const rt = new Runtime(opts);
    const start = await rt.hooks.run('SessionStart', { source: opts.resume ? 'resume' : 'startup' });
    if (start.context.length) rt.main.pendingContext.push(...start.context);
    return rt;
  }

  /** Start MCP connections in the background; tools appear as servers come up. */
  connectMcp(): Promise<void> {
    return this.mcp.connectAll();
  }

  get compactThreshold() {
    return this.settings.autoCompactThreshold ?? 0.85;
  }

  get mode(): PermissionMode {
    return this.permissions.mode;
  }

  setMode(mode: PermissionMode) {
    if (mode === this.permissions.mode) return;
    if (mode === 'plan') this.modeBeforePlan = this.permissions.mode === 'plan' ? this.modeBeforePlan : this.permissions.mode;
    const prev = this.permissions.mode;
    this.permissions.mode = mode;
    const notice =
      mode === 'plan'
        ? 'Plan mode is now active. Investigate with read-only tools only; do not modify files or run state-changing commands. When the plan is complete, call ExitPlanMode with the full plan organized by phases.'
        : prev === 'plan'
          ? `Plan mode has ended; permission mode is now "${mode}". You may make changes.`
          : `Permission mode changed to "${mode}".`;
    this.main.pendingContext.push(notice);
    this.main.modeNotice = notice;
    this.bus.emit({ type: 'mode', mode });
  }

  setModel(spec: string) {
    this.model = this.registry.resolve(spec);
    this.registry.get(this.model.provider);
    this.main.model = this.model;
    this.main.system = this.buildMainSystem();
    this.bus.emit({ type: 'model', model: this.model.id });
  }

  /** Pin the upstream providers for the current model (empty list = automatic routing). */
  setRoute(order: string[]) {
    this.registry.setRoute(this.model, order);
    updateUserSettings({ routes: this.settings.routes });
    this.bus.emit({ type: 'model', model: this.model.id });
  }

  /**
   * Continue a saved session: its history becomes the conversation and further turns are
   * appended to that same file, so resuming twice does not fork the transcript.
   */
  resumeSession(file: string): { id: string; messages: number } {
    const { messages } = SessionStore.load(file);
    const id = path.basename(file, '.jsonl');
    this.session = new SessionStore(this.root, { cwd: this.cwd, root: this.root, model: this.model.id }, id);
    this.main.messages = messages;
    this.resumedId = id;
    this.main.contextTokens = messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content)), 0);
    // No notice here: each front end prints its own line, and the TUI also replays the transcript.
    return { id, messages: messages.length };
  }

  attachTracker(store: TrackerStore) {
    this.trackerUnsub?.();
    this.tracker = store;
    this.trackerUnsub = store.onChange(() => this.bus.emit({ type: 'tracker_changed' }));
  }

  envInfo(model: ModelRef): EnvInfo {
    const git = gitSnapshot(this.cwd);
    return { cwd: this.cwd, root: this.root, model: model.id, isGit: git !== undefined, gitStatus: git };
  }

  buildMainSystem(): string {
    return mainSystemPrompt(this.ext, this.envInfo(this.model), [], this.main ? this.promptCaps(this.main) : undefined);
  }

  /** Catalogs are only worth their tokens when the agent can actually use them. */
  promptCaps(agent: AgentHandle): PromptCapabilities {
    const names = new Set(this.toolsFor(agent).map((t) => t.name));
    return { task: names.has('Task'), skill: names.has('Skill'), tracker: [...names].some((n) => n.startsWith('tasks_')) };
  }

  // ------------------------------------------------------------------ tools

  allTools(): Tool<any>[] {
    const mcpTools = this.mcp.tools();
    const defer = mcpTools.length > 30;
    return [...BUILTIN_TOOLS, ...mcpTools.map((t) => (defer ? { ...t, deferred: true } : t))];
  }

  private allowedByDef(def: AgentDef | undefined, name: string): boolean {
    if (!def) return true;
    if (def.disallowedTools?.some((d) => d === name || expandAlias(d).includes(name))) return false;
    if (!def.tools?.length || def.tools.includes('*')) return true;
    return def.tools.some((t) => {
      if (t === name) return true;
      if (expandAlias(t).includes(name)) return true;
      if (t.startsWith('mcp__') && t.endsWith('*')) return name.startsWith(t.slice(0, -1));
      if (t.startsWith('mcp__') && !t.slice(5).includes('__')) return name.startsWith(t + '__');
      return false;
    });
  }

  toolsFor(agent: AgentHandle): Tool<any>[] {
    const isSub = agent.depth > 0;
    const hasResources = [...this.mcp.servers.values()].some((s) => s.resources > 0);
    const hasDeferred = this.allTools().some((t) => t.deferred);
    return this.allTools().filter((t) => {
      if (isSub && MAIN_ONLY_TOOLS.has(t.name)) return false;
      if (t.deferred && !agent.surfaced.has(t.name)) return false;
      if (t.name === 'ToolSearch' && !hasDeferred) return false;
      if ((t.name === 'ListMcpResources' || t.name === 'ReadMcpResource') && !hasResources) return false;
      if (t.name === 'Skill' && !this.ext.skills.size) return false;
      if (t.name === 'ExitPlanMode' && agent.mode() !== 'plan') return false;
      if (isSub && t.name === 'Skill' && agent.def?.tools?.length && !agent.def.tools.includes('Skill')) return false;
      if (!this.allowedByDef(agent.def, t.name)) {
        // Tracker tools stay available to agents whose tool list names Bash (they would use `br` there anyway).
        if (t.category === 'tasks' && agent.def?.tools?.some((x) => x === 'Bash')) return true;
        return false;
      }
      return true;
    });
  }

  findTool(name: string, agent: AgentHandle): Tool<any> | undefined {
    return this.toolsFor(agent).find((t) => t.name === name) ?? this.allTools().find((t) => t.name === name && t.deferred && agent.surfaced.has(name));
  }

  // ------------------------------------------------------------------ agents

  resolveAgentDef(type: string): AgentDef | undefined {
    return this.ext.agents.get(type) ?? [...this.ext.agents.values()].find((a) => a.name.endsWith(`:${type}`) || a.name.toLowerCase() === type.toLowerCase());
  }

  async runSubagent(req: SubagentRequest): Promise<string> {
    const def = this.resolveAgentDef(req.agentType);
    if (!def) throw new Error(`Unknown agent type "${req.agentType}". Available: ${[...this.ext.agents.keys()].join(', ')}`);
    const model = this.registry.resolveAgentModel(def.model, this.model);
    const mode = def.permissionMode ? MODE_ALIASES[def.permissionMode] : undefined;
    const agent = new Agent({
      runtime: this,
      label: def.name,
      def,
      parent: req.parent,
      model,
      system: subagentSystemPrompt(def, this.ext, this.envInfo(model), { skill: !def.tools || def.tools.includes('Skill') }),
      mode,
    });
    this.bus.emit({ type: 'agent_start', agentId: agent.id, label: `${def.name}: ${req.description}`, parentId: req.parent.id, prompt: req.prompt });
    try {
      const report = await agent.send(req.prompt, req.signal);
      this.bus.emit({ type: 'agent_end', agentId: agent.id, label: def.name, ok: true, summary: report.slice(0, 500) });
      return report;
    } catch (e) {
      this.bus.emit({ type: 'agent_end', agentId: agent.id, label: def.name, ok: false, summary: (e as Error).message });
      throw e;
    }
  }

  /** One-off completion without tools (WebFetch extraction, titles). */
  async oneShot(prompt: string, signal?: AbortSignal): Promise<string> {
    const ref = this.settings.smallModel ? this.registry.resolve(this.settings.smallModel) : this.model;
    const provider = this.registry.get(ref.provider);
    for await (const ev of provider.stream({
      model: ref.model,
      system: 'You are a precise assistant. Answer concisely using only the provided material.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      maxTokens: 4000,
      signal,
      reasoning: 'off',
    })) {
      if (ev.type === 'done') return textOf(ev.message.content);
    }
    return '';
  }

  clearConversation() {
    this.main.messages = [];
    this.main.todos = [];
    this.main.contextTokens = 0;
    this.main.system = this.buildMainSystem();
    this.session.reset('clear');
    this.bus.emit({ type: 'todos', agentId: 'main', todos: [] });
  }

  async shutdown() {
    await this.hooks.run('SessionEnd', { reason: 'exit' }).catch(() => {});
    killAllShells(this);
    await this.mcp.closeAll();
  }

  /** Save a permanent allow rule into .alteran/settings.local.json. */
  persistAllowRule(rule: string) {
    const file = path.join(this.root, '.alteran', 'settings.local.json');
    let json: Settings = {};
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    const allow = new Set(json.permissions?.allow ?? []);
    allow.add(rule);
    json.permissions = { ...json.permissions, allow: [...allow] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  }
}

function expandAlias(name: string): string[] {
  return TOOL_ALIASES[name] ?? [];
}
