import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  alteranHome,
  claudeHome,
  codexHome,
  HOME,
  assetPath,
  expandHome,
  isDir,
  isFile,
  readJson,
} from '../config/paths.js';
import type { HookMatcher, McpServerConfig, Settings } from '../config/settings.js';
import { parseFrontmatter, toList } from './frontmatter.js';
import type { AgentDef, CommandDef, Extensions, InstructionFile, Origin, PluginDef, SkillDef } from './types.js';

interface LoadOptions {
  cwd: string;
  root: string;
  settings: Settings;
}

function listMd(dir: string, recursive = true): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && recursive && !e.name.startsWith('.')) out.push(...listMd(p, recursive));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Expand ${VAR}, ${VAR:-default} and $VAR in config strings. */
export function expandVars(s: string, extra: Record<string, string> = {}): string {
  const env = { ...process.env, ...extra } as Record<string, string | undefined>;
  return s
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, def) => env[k] ?? def ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => env[k] ?? m);
}

function expandServer(cfg: McpServerConfig, extra: Record<string, string> = {}): McpServerConfig {
  const x = (s: string) => expandVars(s, extra);
  return {
    ...cfg,
    command: cfg.command ? x(cfg.command) : undefined,
    args: cfg.args?.map(x),
    url: cfg.url ? x(cfg.url) : undefined,
    cwd: cfg.cwd ? x(cfg.cwd) : undefined,
    env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, x(String(v))])) : undefined,
    headers: cfg.headers ? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, x(String(v))])) : undefined,
  };
}

export class ExtensionLoader {
  readonly ext: Extensions = {
    agents: new Map(),
    commands: new Map(),
    skills: new Map(),
    plugins: [],
    mcpServers: new Map(),
    hookSources: [],
    rules: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    env: {},
    instructions: [],
    warnings: [],
  };

  constructor(private opts: LoadOptions) {}

  private get compat() {
    const c = this.opts.settings.compat ?? {};
    return {
      claude: c.claude !== false,
      codex: c.codex !== false,
      agents: c.agents !== false,
      cursor: c.cursor !== false,
      gemini: c.gemini !== false,
    };
  }

  load(): Extensions {
    const { root } = this.opts;
    const c = this.compat;

    this.loadAgentsDir(assetPath('agents'), 'builtin');
    this.loadCommandsDir(assetPath('commands'), 'builtin');

    if (c.claude) this.loadClaude();
    if (c.codex) this.loadCodex();
    if (c.agents) {
      this.loadSkillsDir(path.join(HOME, '.agents', 'skills'), 'agents');
      this.loadSkillsDir(path.join(root, '.agents', 'skills'), 'agents');
      this.loadAgentsDir(path.join(root, '.agents', 'agents'), 'agents');
    }
    if (c.cursor) {
      this.loadMcpJson(path.join(HOME, '.cursor', 'mcp.json'), 'cursor');
      this.loadMcpJson(path.join(root, '.cursor', 'mcp.json'), 'cursor');
    }
    if (c.gemini) {
      this.loadMcpJson(path.join(HOME, '.gemini', 'settings.json'), 'gemini');
      this.loadMcpJson(path.join(root, '.gemini', 'settings.json'), 'gemini');
    }

    // Native alteran locations win over everything else.
    for (const base of [alteranHome(), path.join(root, '.alteran')]) {
      this.loadAgentsDir(path.join(base, 'agents'), 'alteran');
      this.loadCommandsDir(path.join(base, 'commands'), 'alteran');
      this.loadSkillsDir(path.join(base, 'skills'), 'alteran');
      this.loadMcpJson(path.join(base, 'mcp.json'), 'alteran');
    }
    this.loadAlteranPlugins();
    const s = this.opts.settings;
    for (const [name, cfg] of Object.entries(s.mcpServers ?? {})) this.addMcp(name, cfg, 'alteran');
    if (s.hooks) this.ext.hookSources.push({ hooks: s.hooks, origin: 'alteran settings' });
    this.ext.rules.allow.push(...(s.permissions?.allow ?? []));
    this.ext.rules.deny.push(...(s.permissions?.deny ?? []));
    this.ext.rules.ask.push(...(s.permissions?.ask ?? []));
    this.ext.rules.additionalDirectories.push(...(s.permissions?.additionalDirectories ?? []));
    Object.assign(this.ext.env, s.env ?? {});
    for (const name of s.disabledMcpServers ?? []) this.ext.mcpServers.delete(name);

    this.ext.instructions = this.loadInstructions();
    return this.ext;
  }

  // ------------------------------------------------------------------ generic loaders

  loadAgentsDir(dir: string, origin: Origin, prefix = '') {
    for (const file of listMd(dir)) {
      const text = read(file);
      if (!text) continue;
      const { data, body } = parseFrontmatter<Record<string, unknown>>(text);
      const name = String(data.name ?? path.basename(file, '.md'));
      if (!name) continue;
      const def: AgentDef = {
        name: prefix + name,
        description: unescapeDesc(String(data.description ?? '')),
        prompt: body.trim(),
        tools: toList(data.tools),
        disallowedTools: toList(data.disallowedTools),
        model: data.model ? String(data.model) : undefined,
        permissionMode: data.permissionMode ? String(data.permissionMode) : undefined,
        memory: ['user', 'project', 'local'].includes(String(data.memory)) ? (String(data.memory) as AgentDef['memory']) : undefined,
        color: data.color ? String(data.color) : undefined,
        origin,
        file,
      };
      this.ext.agents.set(def.name, def);
    }
  }

  loadCommandsDir(dir: string, origin: Origin, prefix = '') {
    for (const file of listMd(dir)) {
      const text = read(file);
      if (text == null) continue;
      const { data, body } = parseFrontmatter<Record<string, unknown>>(text);
      const rel = path.relative(dir, file).replace(/\.md$/, '');
      const name = prefix + rel.split(path.sep).join(':');
      const def: CommandDef = {
        name,
        description: data.description ? String(data.description) : firstLine(body),
        argumentHint: data['argument-hint'] ? String(data['argument-hint']) : undefined,
        allowedTools: toList(data['allowed-tools']),
        model: data.model ? String(data.model) : undefined,
        body,
        origin,
        file,
      };
      this.ext.commands.set(name, def);
    }
  }

  loadSkillsDir(dir: string, origin: Origin, prefix = '') {
    if (!isDir(dir)) return;
    const visit = (d: string, depth: number) => {
      const skillFile = path.join(d, 'SKILL.md');
      if (isFile(skillFile)) {
        const text = read(skillFile) ?? '';
        const { data } = parseFrontmatter<Record<string, unknown>>(text);
        const name = prefix + String(data.name ?? path.basename(d));
        const def: SkillDef = {
          name,
          description: String(data.description ?? firstLine(text) ?? ''),
          dir: d,
          file: skillFile,
          origin,
          allowedTools: toList(data['allowed-tools']),
        };
        this.ext.skills.set(name, def);
        return;
      }
      if (depth >= 2) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if ((e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')) visit(path.join(d, e.name), depth + 1);
      }
    };
    visit(dir, 0);
  }

  loadMcpJson(file: string, origin: Origin, extra: Record<string, string> = {}, prefix = '') {
    const json = readJson<Record<string, unknown>>(file);
    if (!json) return;
    const servers = (json.mcpServers ?? json.servers ?? (file.endsWith('.mcp.json') ? json : undefined)) as
      | Record<string, McpServerConfig & { httpUrl?: string; serverUrl?: string }>
      | undefined;
    if (!servers || typeof servers !== 'object') return;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const url = cfg.url ?? cfg.httpUrl ?? cfg.serverUrl;
      this.addMcp(prefix + name, { ...cfg, url }, origin, extra);
    }
  }

  private addMcp(name: string, cfg: McpServerConfig, origin: Origin, extra: Record<string, string> = {}) {
    if (cfg.disabled) return;
    if (!cfg.command && !cfg.url) return;
    this.ext.mcpServers.set(name, { name, config: expandServer(cfg, extra), origin });
  }

  // ------------------------------------------------------------------ Claude Code

  private loadClaude() {
    const { root } = this.opts;
    this.loadAgentsDir(path.join(claudeHome(), 'agents'), 'claude');
    this.loadCommandsDir(path.join(claudeHome(), 'commands'), 'claude');
    this.loadSkillsDir(path.join(claudeHome(), 'skills'), 'claude');

    const claudeJson = readJson<Record<string, any>>(path.join(HOME, '.claude.json')) ?? {};
    for (const [name, cfg] of Object.entries<McpServerConfig>(claudeJson.mcpServers ?? {})) this.addMcp(name, cfg, 'claude');
    const proj = claudeJson.projects?.[root] ?? {};
    for (const [name, cfg] of Object.entries<McpServerConfig>(proj.mcpServers ?? {})) this.addMcp(name, cfg, 'claude');

    const disabledMcpJson = new Set<string>(proj.disabledMcpjsonServers ?? []);
    const before = new Set(this.ext.mcpServers.keys());
    this.loadMcpJson(path.join(root, '.mcp.json'), 'claude');
    for (const name of disabledMcpJson) if (!before.has(name)) this.ext.mcpServers.delete(name);

    this.loadAgentsDir(path.join(root, '.claude', 'agents'), 'claude');
    this.loadCommandsDir(path.join(root, '.claude', 'commands'), 'claude');
    this.loadSkillsDir(path.join(root, '.claude', 'skills'), 'claude');

    const layers = [
      path.join(claudeHome(), 'settings.json'),
      path.join(root, '.claude', 'settings.json'),
      path.join(root, '.claude', 'settings.local.json'),
    ];
    const enabled = new Map<string, boolean>();
    for (const file of layers) {
      const s = readJson<Record<string, any>>(file);
      if (!s) continue;
      const p = s.permissions ?? {};
      this.ext.rules.allow.push(...(p.allow ?? []));
      this.ext.rules.deny.push(...(p.deny ?? []));
      this.ext.rules.ask.push(...(p.ask ?? []));
      this.ext.rules.additionalDirectories.push(...(p.additionalDirectories ?? []));
      if (s.hooks) this.ext.hookSources.push({ hooks: normalizeHooks(s.hooks), origin: file });
      Object.assign(this.ext.env, s.env ?? {});
      for (const [k, v] of Object.entries(s.enabledPlugins ?? {})) enabled.set(k, Boolean(v));
    }
    this.loadClaudePlugins(enabled);
  }

  private loadClaudePlugins(enabled: Map<string, boolean>) {
    const installed = readJson<{ plugins?: Record<string, Array<{ scope: string; installPath: string; projectPath?: string; version?: string }>> }>(
      path.join(claudeHome(), 'plugins', 'installed_plugins.json'),
    );
    const disabled = new Set(this.opts.settings.disabledPlugins ?? []);
    for (const [key, entries] of Object.entries(installed?.plugins ?? {})) {
      if (!enabled.get(key) || disabled.has(key)) continue;
      const entry =
        entries.find((e) => e.scope === 'project' && e.projectPath === this.opts.root) ??
        entries.find((e) => e.scope === 'local' && e.projectPath === this.opts.root) ??
        entries.find((e) => e.scope === 'user');
      if (!entry || !isDir(entry.installPath)) continue;
      this.loadPlugin({ key, name: key.split('@')[0], root: entry.installPath, version: entry.version, origin: 'claude' });
    }
  }

  private loadAlteranPlugins() {
    const disabled = new Set(this.opts.settings.disabledPlugins ?? []);
    for (const base of [path.join(alteranHome(), 'plugins'), path.join(this.opts.root, '.alteran', 'plugins')]) {
      if (!isDir(base)) continue;
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory() || disabled.has(e.name)) continue;
        this.loadPlugin({ key: e.name, name: e.name, root: path.join(base, e.name), origin: 'alteran' });
      }
    }
  }

  /** Claude Code plugin layout: .claude-plugin/plugin.json + commands/ agents/ skills/ hooks/hooks.json .mcp.json */
  loadPlugin(p: PluginDef) {
    const manifest =
      readJson<Record<string, any>>(path.join(p.root, '.claude-plugin', 'plugin.json')) ??
      readJson<Record<string, any>>(path.join(p.root, 'plugin.json')) ??
      {};
    const name = String(manifest.name ?? p.name);
    const plugin: PluginDef = { ...p, name, version: manifest.version ?? p.version };
    this.ext.plugins.push(plugin);
    const origin = `plugin:${name}` as Origin;
    const env = { CLAUDE_PLUGIN_ROOT: p.root, ALTERAN_PLUGIN_ROOT: p.root };
    const paths = (field: unknown, def: string): string[] => {
      const list = field == null ? [def] : Array.isArray(field) ? field : [field];
      return list.filter((x): x is string => typeof x === 'string').map((x) => path.resolve(p.root, expandVars(x, env)));
    };
    for (const d of paths(manifest.commands, 'commands')) this.loadCommandsDir(d, origin, `${name}:`);
    for (const d of paths(manifest.agents, 'agents')) {
      if (isFile(d)) this.loadAgentsDir(path.dirname(d), origin, `${name}:`);
      else this.loadAgentsDir(d, origin, `${name}:`);
    }
    for (const d of paths(manifest.skills, 'skills')) this.loadSkillsDir(d, origin, `${name}:`);

    const hookFiles = typeof manifest.hooks === 'object' && manifest.hooks && !Array.isArray(manifest.hooks) ? [] : paths(manifest.hooks, 'hooks/hooks.json');
    for (const f of hookFiles) {
      const json = readJson<Record<string, any>>(f);
      if (json?.hooks) this.ext.hookSources.push({ hooks: normalizeHooks(json.hooks), env, origin });
    }
    if (typeof manifest.hooks === 'object' && manifest.hooks && !Array.isArray(manifest.hooks)) {
      const h = manifest.hooks.hooks ?? manifest.hooks;
      this.ext.hookSources.push({ hooks: normalizeHooks(h), env, origin });
    }

    const mcpPrefix = `plugin_${name}_`;
    if (manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
      for (const [n, cfg] of Object.entries<McpServerConfig>(manifest.mcpServers)) this.addMcp(mcpPrefix + n, cfg, origin, env);
    } else {
      for (const f of paths(manifest.mcpServers, '.mcp.json')) this.loadMcpJson(f, origin, env, mcpPrefix);
    }
  }

  // ------------------------------------------------------------------ Codex

  private loadCodex() {
    const cfgFile = path.join(codexHome(), 'config.toml');
    if (isFile(cfgFile)) {
      try {
        const toml = parseToml(read(cfgFile) ?? '') as Record<string, any>;
        for (const [name, s] of Object.entries<Record<string, any>>(toml.mcp_servers ?? {})) {
          if (s.enabled === false) continue;
          const headers: Record<string, string> = { ...(s.http_headers ?? {}) };
          if (s.bearer_token_env_var && process.env[s.bearer_token_env_var]) {
            headers.Authorization = `Bearer ${process.env[s.bearer_token_env_var]}`;
          }
          for (const [h, envName] of Object.entries<string>(s.env_http_headers ?? {})) {
            if (process.env[envName]) headers[h] = process.env[envName]!;
          }
          this.addMcp(name, { command: s.command, args: s.args, env: s.env, cwd: s.cwd, url: s.url, headers }, 'codex');
        }
      } catch (e) {
        this.ext.warnings.push(`${cfgFile}: ${(e as Error).message}`);
      }
    }
    this.loadSkillsDir(path.join(codexHome(), 'skills'), 'codex');
    for (const file of listMd(path.join(codexHome(), 'prompts'), false)) {
      const name = path.basename(file, '.md');
      if (this.ext.commands.has(name)) continue;
      const text = read(file) ?? '';
      const { data, body } = parseFrontmatter<Record<string, unknown>>(text);
      this.ext.commands.set(name, {
        name,
        description: data.description ? String(data.description) : firstLine(body),
        argumentHint: data['argument-hint'] ? String(data['argument-hint']) : undefined,
        body,
        origin: 'codex',
        file,
      });
    }
  }

  // ------------------------------------------------------------------ instructions

  private loadInstructions(): InstructionFile[] {
    const { root, cwd } = this.opts;
    const c = this.compat;
    const files: string[] = [];
    if (c.claude) files.push(path.join(claudeHome(), 'CLAUDE.md'));
    if (c.codex) files.push(path.join(codexHome(), 'AGENTS.md'));
    files.push(path.join(alteranHome(), 'ALTERAN.md'));
    const dirs: string[] = [];
    let d = path.resolve(cwd);
    while (d.startsWith(root)) {
      dirs.unshift(d);
      if (d === root) break;
      d = path.dirname(d);
    }
    if (!dirs.length) dirs.push(root);
    for (const dir of dirs) {
      if (c.claude) files.push(path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'));
      files.push(path.join(dir, 'AGENTS.md'), path.join(dir, 'ALTERAN.md'));
    }
    const seen = new Set<string>();
    const out: InstructionFile[] = [];
    for (const f of files) {
      if (!isFile(f)) continue;
      const real = fs.realpathSync(f);
      if (seen.has(real)) continue;
      seen.add(real);
      const content = expandImports(read(f) ?? '', path.dirname(f), 0, seen);
      if (content.trim()) out.push({ file: f, content });
    }
    return out;
  }
}

/** CLAUDE.md `@path` imports (one per line), up to 4 levels deep. */
function expandImports(text: string, base: string, depth: number, seen: Set<string>): string {
  if (depth > 4) return text;
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      const m = !inFence && line.match(/^\s*@(\S+)\s*$/);
      if (!m) return line;
      const target = path.resolve(base, expandHome(m[1]));
      if (!isFile(target) || seen.has(target)) return line;
      seen.add(target);
      return expandImports(read(target) ?? '', path.dirname(target), depth + 1, seen);
    })
    .join('\n');
}

function normalizeHooks(h: Record<string, unknown>): Record<string, HookMatcher[]> {
  const out: Record<string, HookMatcher[]> = {};
  for (const [event, list] of Object.entries(h)) {
    if (!Array.isArray(list)) continue;
    out[event] = list
      .filter((m) => m && Array.isArray((m as HookMatcher).hooks))
      .map((m) => ({
        matcher: (m as HookMatcher).matcher || undefined,
        hooks: (m as HookMatcher).hooks.map((x) => ({ ...x, type: x.type ?? 'command', command: x.command ? expandHome(x.command) : undefined })),
      }));
  }
  return out;
}

function firstLine(s: string): string | undefined {
  const l = s.split('\n').find((x) => x.trim() && !x.startsWith('---'));
  return l?.replace(/^#+\s*/, '').trim().slice(0, 120);
}

function unescapeDesc(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"');
}

export function loadExtensions(opts: LoadOptions): Extensions {
  return new ExtensionLoader(opts).load();
}
