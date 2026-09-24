import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetPath, claudeHome, alteranHome, HOME } from '../config/paths.js';
import type { AgentDef, Extensions } from '../compat/types.js';

export interface EnvInfo {
  cwd: string;
  root: string;
  model: string;
  isGit: boolean;
  gitStatus?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return undefined;
  }
}

export function gitSnapshot(cwd: string): string | undefined {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === undefined) return undefined;
  const status = git(cwd, ['status', '--short']) ?? '';
  const log = git(cwd, ['log', '--oneline', '-5']) ?? '';
  const lines = status.split('\n').filter(Boolean);
  const shown = lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n... (${lines.length - 40} more)` : '');
  return `Current branch: ${branch}\n\nStatus:\n${shown || '(clean)'}\n\nRecent commits:\n${log || '(none)'}`;
}

export function environmentBlock(env: EnvInfo): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    '<env>',
    `Working directory: ${env.cwd}`,
    env.root === env.cwd ? '' : `Project root: ${env.root}`,
    `Is a git repository: ${env.isGit}`,
    `Platform: ${process.platform} (${os.release()})`,
    `Shell: ${process.env.SHELL ?? 'sh'}`,
    `Today's date: ${date}`,
    `Model: ${env.model}`,
    '</env>',
    env.gitStatus ? `\n<git-status snapshot="session start">\n${env.gitStatus}\n</git-status>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function instructionsBlock(ext: Extensions): string {
  if (!ext.instructions.length) return '';
  const parts = ext.instructions.map((i) => {
    const kind = i.file.startsWith(HOME + path.sep + '.') ? "user's private global instructions" : 'project instructions';
    return `Contents of ${i.file} (${kind}):\n\n${i.content.trim()}`;
  });
  return `# Instructions\nThese instructions from the user and project override default behavior. Follow them exactly.\n\n${parts.join('\n\n---\n\n')}`;
}

/**
 * Catalog descriptions are written for humans and run long; the model only needs enough to
 * choose. Examples, usage transcripts and trailing headings are dropped.
 */
function summarize(text: string, limit: number): string {
  const cleaned = text
    .replace(/<example>[\s\S]*?<\/example>/g, ' ')
    .replace(/<commentary>[\s\S]*?<\/commentary>/g, ' ')
    .split(/\n\s*(?:Examples?|Usage|Пример(?:ы)?)\s*:?\s*$/m)[0]
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:Examples?|Usage|Пример(?:ы)?)\s*:?\s*$/i, '')
    .trim();
  if (cleaned.length <= limit) return cleaned;
  // Prefer cutting at a sentence end so the entry does not trail off mid-word.
  const head = cleaned.slice(0, limit);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return (stop > limit * 0.5 ? head.slice(0, stop + 1) : head.trimEnd() + '…').trim();
}

function skillsBlock(ext: Extensions): string {
  if (!ext.skills.size) return '';
  const lines = [...ext.skills.values()].map((s) => `- ${s.name}: ${summarize(s.description, 180)}`);
  return `# Skills\nCall the Skill tool with the exact name when a task matches:\n${lines.join('\n')}`;
}

function agentsBlock(ext: Extensions): string {
  if (!ext.agents.size) return '';
  const lines = [...ext.agents.values()].map((a) => `- ${a.name}: ${summarize(a.description, 220)}`);
  return `# Agent types for the Task tool\n${lines.join('\n')}`;
}

let baseCache: string | null = null;
function basePrompt(caps: PromptCapabilities = {}): string {
  if (baseCache == null) baseCache = fs.readFileSync(assetPath('prompts', 'system.md'), 'utf8');
  let out = baseCache;
  // The tracker section is a third of the base prompt and useless without the tasks_* tools.
  if (caps.tracker === false) out = dropSection(out, '# The CONSILIUM task tracker');
  // Likewise, telling an agent how to delegate when it cannot is pure cost.
  if (caps.task === false) out = dropSection(out, '# Orchestration');
  return out;
}

function dropSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return text;
  const next = text.indexOf('\n# ', start + heading.length);
  return (text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1))).trim();
}

/** The blocks the main system prompt is assembled from, for the /context breakdown. */
/** Which catalogs are worth sending: listing agents the model cannot launch is pure cost. */
export interface PromptCapabilities {
  task?: boolean;
  skill?: boolean;
  tracker?: boolean;
}

export function systemSections(
  ext: Extensions,
  env: EnvInfo,
  caps: PromptCapabilities = { task: true, skill: true },
): {
  base: string;
  agents: string;
  skills: string;
  env: string;
  instructions: string;
} {
  return {
    base: basePrompt(caps).trim(),
    agents: caps.task === false ? '' : agentsBlock(ext),
    skills: caps.skill === false ? '' : skillsBlock(ext),
    env: environmentBlock(env),
    instructions: instructionsBlock(ext),
  };
}

export function mainSystemPrompt(ext: Extensions, env: EnvInfo, extra: string[] = [], caps?: PromptCapabilities): string {
  const s = systemSections(ext, env, caps);
  return [s.base, s.agents, s.skills, s.env, s.instructions, ...extra].filter(Boolean).join('\n\n');
}

export function memoryDir(def: AgentDef, root: string): string | undefined {
  if (!def.memory) return undefined;
  const claudeStyle = def.origin === 'claude' || def.origin.startsWith('plugin:');
  if (def.memory === 'user') return path.join(claudeStyle ? claudeHome() : alteranHome(), 'agent-memory', def.name);
  const base = path.join(root, claudeStyle ? '.claude' : '.alteran');
  return path.join(base, def.memory === 'local' ? 'agent-memory-local' : 'agent-memory', def.name);
}

function memoryBlock(def: AgentDef, root: string): string {
  const dir = memoryDir(def, root);
  if (!dir) return '';
  let index = '';
  try {
    index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').split('\n').slice(0, 200).join('\n');
  } catch {}
  return `# Persistent agent memory
You have a persistent memory directory at ${dir}. Its contents persist across runs.
- Consult it before working; record stable, verified learnings (code paths, conventions, pitfalls, user preferences) as concise notes.
- MEMORY.md is an index loaded into this prompt (first 200 lines); put details in topic files and link them from MEMORY.md.
- Update or remove notes that turn out to be wrong. Do not store session-specific state.
Use Write/Edit to maintain it (create the directory if missing).

## MEMORY.md
${index.trim() || '(empty)'}`;
}

export function subagentSystemPrompt(def: AgentDef, ext: Extensions, env: EnvInfo, caps: PromptCapabilities = {}): string {
  return [
    def.prompt.trim() || 'You are a helpful engineering subagent. Complete the delegated task and return a concise report.',
    'You are running as an agent inside the alteran terminal, working on a task the orchestrator delegated to you. Your final message is returned to it as your report, so make it self-contained: it is the only thing that crosses back.',
    'Reporting does not end you. The orchestrator can send you another message, and you will still have this conversation, so do not repeat your whole report when answering a follow-up.',
    'When something needs time — a build, a deploy, a queue — you may schedule a check or a reminder for later instead of waiting on it. It comes back to you: if you have already reported by then, you are woken with this same context, and what you find goes on to the orchestrator.',
    memoryBlock(def, env.root),
    caps.skill === false ? '' : skillsBlock(ext),
    environmentBlock(env),
    instructionsBlock(ext),
  ]
    .filter(Boolean)
    .join('\n\n');
}
