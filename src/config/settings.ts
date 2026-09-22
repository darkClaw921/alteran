import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { alteranHome, projectRoot, readJson } from './paths.js';

export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'autonomous']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ReasoningSchema = z.enum(['off', 'low', 'medium', 'high']);

const ModelInfoSchema = z.object({
  contextWindow: z.number().optional(),
  maxOutput: z.number().optional(),
});

export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'openai-compat']),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  reasoningField: z.enum(['openrouter', 'openai', 'none']).optional(),
  anthropicCaching: z.boolean().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelInfoSchema).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const HookCommandSchema = z.object({
  type: z.string().default('command'),
  command: z.string().optional(),
  timeout: z.number().optional(),
}).loose();

export const HookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema),
});
export type HookMatcher = z.infer<typeof HookMatcherSchema>;

export const McpServerSchema = z.object({
  type: z.enum(['stdio', 'http', 'sse', 'streamable-http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
}).loose();
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const SettingsSchema = z.object({
  model: z.string().optional(),
  /** Cheaper model for compaction, titles and `model: haiku` subagents. */
  smallModel: z.string().optional(),
  reasoning: ReasoningSchema.optional(),
  maxOutputTokens: z.number().optional(),
  autoCompactThreshold: z.number().min(0.3).max(0.98).optional(),
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
  modelAliases: z.record(z.string(), z.string()).optional(),
  /** Pinned upstream providers per "provider:model", best first (polza/OpenRouter routing). */
  routes: z.record(z.string(), z.array(z.string())).optional(),
  permissions: z
    .object({
      defaultMode: PermissionModeSchema.optional(),
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .optional(),
  hooks: z.record(z.string(), z.array(HookMatcherSchema)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  disabledMcpServers: z.array(z.string()).optional(),
  disabledPlugins: z.array(z.string()).optional(),
  /** Which foreign ecosystems to import agents/skills/plugins/MCP from. */
  compat: z
    .object({
      claude: z.boolean().optional(),
      codex: z.boolean().optional(),
      agents: z.boolean().optional(),
      cursor: z.boolean().optional(),
      gemini: z.boolean().optional(),
    })
    .optional(),
  /** Show the ASTRIA PORTA / VIRES side panels on start (default: console only). */
  panels: z.boolean().optional(),
  /** Report the mouse wheel to the TUI so the console scrolls (default: true). */
  mouse: z.boolean().optional(),
  /** Play the gate-dialling animation while the agent starts (default: true). */
  intro: z.boolean().optional(),
  /** TUI palette: dark (default, readable) | contrast | design (mockup colors). */
  theme: z.enum(['dark', 'contrast', 'design']).optional(),
  /** Per-turn token budget shown in the status bar. */
  budgetTokens: z.number().optional(),
}).loose();
export type Settings = z.infer<typeof SettingsSchema>;

export function settingsFiles(cwd: string): string[] {
  const root = projectRoot(cwd);
  return [
    path.join(alteranHome(), 'settings.json'),
    path.join(root, '.alteran', 'settings.json'),
    path.join(root, '.alteran', 'settings.local.json'),
  ];
}

function mergeSettings(base: Settings, over: Settings): Settings {
  const out: Settings = { ...base, ...over };
  out.providers = { ...base.providers, ...over.providers };
  out.modelAliases = { ...base.modelAliases, ...over.modelAliases };
  out.env = { ...base.env, ...over.env };
  out.mcpServers = { ...base.mcpServers, ...over.mcpServers };
  out.compat = { ...base.compat, ...over.compat };
  out.permissions = {
    ...base.permissions,
    ...over.permissions,
    allow: [...(base.permissions?.allow ?? []), ...(over.permissions?.allow ?? [])],
    deny: [...(base.permissions?.deny ?? []), ...(over.permissions?.deny ?? [])],
    ask: [...(base.permissions?.ask ?? []), ...(over.permissions?.ask ?? [])],
  };
  const hooks: Record<string, z.infer<typeof HookMatcherSchema>[]> = { ...base.hooks };
  for (const [ev, list] of Object.entries(over.hooks ?? {})) hooks[ev] = [...(hooks[ev] ?? []), ...list];
  out.hooks = hooks;
  out.disabledMcpServers = [...(base.disabledMcpServers ?? []), ...(over.disabledMcpServers ?? [])];
  out.disabledPlugins = [...(base.disabledPlugins ?? []), ...(over.disabledPlugins ?? [])];
  return out;
}

export interface LoadedSettings {
  settings: Settings;
  errors: string[];
}

export function loadSettings(cwd: string): LoadedSettings {
  let settings: Settings = {};
  const errors: string[] = [];
  for (const file of settingsFiles(cwd)) {
    if (!fs.existsSync(file)) continue;
    const raw = readJson(file);
    if (raw === null) {
      errors.push(`${file}: invalid JSON`);
      continue;
    }
    const parsed = SettingsSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    settings = mergeSettings(settings, parsed.data);
  }
  return { settings, errors };
}

/** Persist a partial update into the user-level settings file. */
export function updateUserSettings(patch: Partial<Settings>) {
  const file = path.join(alteranHome(), 'settings.json');
  const current = (readJson<Settings>(file) ?? {}) as Settings;
  fs.mkdirSync(alteranHome(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
}

export { mergeSettings };
