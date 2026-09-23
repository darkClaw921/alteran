export { toolJsonSchema, toolSpec } from './schema.js';
import type { Tool } from './types.js';
import { BashOutputTool, BashTool, KillShellTool } from './bash.js';
import { EditTool, MultiEditTool, ReadTool, WriteTool } from './fs-tools.js';
import { AskUserQuestionTool, ExitPlanModeTool, TodoWriteTool, WebFetchTool } from './misc-tools.js';
import { GlobTool, GrepTool } from './search-tools.js';
import { WebSearchTool } from './web-search.js';
import {
  ListAgentsTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  ScheduleCancelTool,
  ScheduleListTool,
  ScheduleTool,
  SendMessageTool,
  SkillTool,
  TaskStopTool,
  TaskTool,
  ToolSearchTool,
} from './meta-tools.js';
import { trackerTools } from '../tracker/tools.js';

export const BUILTIN_TOOLS: Tool<any>[] = [
  TaskTool,
  ListAgentsTool,
  SendMessageTool,
  TaskStopTool,
  ScheduleTool,
  ScheduleListTool,
  ScheduleCancelTool,
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
  WebSearchTool,
  TodoWriteTool,
  AskUserQuestionTool,
  ExitPlanModeTool,
  SkillTool,
  ToolSearchTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  ...trackerTools,
];

/** Tools that subagents never get: they do not talk to the user and do not approve plans. */
export const MAIN_ONLY_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Delegation tools, handed out while the agent is below the nesting budget. */
export const ORCHESTRATION_TOOLS = new Set(['Task', 'ListAgents', 'SendMessage', 'TaskStop']);

/** Claude Code tool names that map onto ours when agent files list them. */
export const TOOL_ALIASES: Record<string, string[]> = {
  LS: ['Glob', 'Bash'],
  NotebookEdit: ['Edit'],
  NotebookRead: ['Read'],
  TodoRead: ['TodoWrite'],
  Agent: ['Task'],
};
