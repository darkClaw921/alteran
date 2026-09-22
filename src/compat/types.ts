import type { HookMatcher, McpServerConfig } from '../config/settings.js';
import type { RuleSources } from '../permissions/permissions.js';

export type Origin = 'builtin' | 'alteran' | 'claude' | 'codex' | 'agents' | 'cursor' | 'gemini' | `plugin:${string}`;

export interface AgentDef {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: string;
  memory?: 'user' | 'project' | 'local';
  color?: string;
  origin: Origin;
  file?: string;
}

export interface CommandDef {
  name: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  body: string;
  origin: Origin;
  file: string;
}

export interface SkillDef {
  name: string;
  description: string;
  dir: string;
  file: string;
  origin: Origin;
  allowedTools?: string[];
}

export interface PluginDef {
  key: string;
  name: string;
  root: string;
  version?: string;
  origin: 'claude' | 'alteran';
}

export interface McpServerDef {
  name: string;
  config: McpServerConfig;
  origin: Origin;
}

export interface HookSourceDef {
  hooks: Record<string, HookMatcher[]>;
  env?: Record<string, string>;
  origin: string;
}

export interface InstructionFile {
  file: string;
  content: string;
}

export interface Extensions {
  agents: Map<string, AgentDef>;
  commands: Map<string, CommandDef>;
  skills: Map<string, SkillDef>;
  plugins: PluginDef[];
  mcpServers: Map<string, McpServerDef>;
  hookSources: HookSourceDef[];
  rules: RuleSources;
  env: Record<string, string>;
  instructions: InstructionFile[];
  warnings: string[];
}
