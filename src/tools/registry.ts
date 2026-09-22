export { toolJsonSchema, toolSpec } from './schema.js';
import type { Tool } from './types.js';
import { BashOutputTool, BashTool, KillShellTool } from './bash.js';
import { EditTool, MultiEditTool, ReadTool, WriteTool } from './fs-tools.js';
import { AskUserQuestionTool, ExitPlanModeTool, TodoWriteTool, WebFetchTool } from './misc-tools.js';
import { GlobTool, GrepTool } from './search-tools.js';
import { ListMcpResourcesTool, ReadMcpResourceTool, SkillTool, TaskTool, ToolSearchTool } from './meta-tools.js';
import { trackerTools } from '../tracker/tools.js';

export const BUILTIN_TOOLS: Tool<any>[] = [
  TaskTool,
  BashTool,
  BashOutputTool,
  KillShellTool,
  GlobTool,
  GrepTool,
  ReadTool,
  EditTool,
  MultiEditTool,
  WriteTool,
  WebFetchTool,
  TodoWriteTool,
  AskUserQuestionTool,
  ExitPlanModeTool,
  SkillTool,
  ToolSearchTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  ...trackerTools,
];

/** Tools that subagents never get (no nesting, no user interaction, no plan approval). */
export const MAIN_ONLY_TOOLS = new Set(['Task', 'AskUserQuestion', 'ExitPlanMode']);

/** Claude Code tool names that map onto ours when agent files list them. */
export const TOOL_ALIASES: Record<string, string[]> = {
  LS: ['Glob', 'Bash'],
  NotebookEdit: ['Edit'],
  NotebookRead: ['Read'],
  WebSearch: ['WebFetch'],
  TodoRead: ['TodoWrite'],
  Agent: ['Task'],
};
