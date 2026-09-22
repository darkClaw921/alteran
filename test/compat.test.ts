import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadExtensions } from '../src/compat/loader.js';
import { parseFrontmatter, toList } from '../src/compat/frontmatter.js';

let root: string;
let home: string;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-proj-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'alteran-home-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.ALTERAN_HOME = path.join(home, '.alteran');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.ALTERAN_HOME;
});

describe('frontmatter', () => {
  it('parses yaml and survives loose descriptions', () => {
    const { data, body } = parseFrontmatter<{ name: string; tools: string }>(
      '---\nname: run-phase\ndescription: "Use when: phases, tasks"\ntools: Read, Bash\n---\nBody here',
    );
    expect(data.name).toBe('run-phase');
    expect(toList(data.tools)).toEqual(['Read', 'Bash']);
    expect(body.trim()).toBe('Body here');
  });

  it('falls back to a line parser for invalid yaml', () => {
    const { data } = parseFrontmatter<{ description: string }>('---\ndescription: broken: "quotes\nname: x\n---\nbody');
    expect(data.description).toContain('broken');
  });
});

describe('extension loading', () => {
  it('loads agents, commands, skills and MCP servers from Claude Code layout', () => {
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\nBe strict.');
    write(path.join(root, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\nargument-hint: <env>\n---\nDeploy to $ARGUMENTS');
    write(path.join(root, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: How to deploy\n---\nSteps');
    write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['s.js'] } } }));
    write(path.join(root, 'CLAUDE.md'), '# Project rules\nUse tabs.');

    const ext = loadExtensions({ cwd: root, root, settings: {} });
    expect(ext.agents.get('reviewer')?.tools).toEqual(['Read', 'Grep']);
    expect(ext.agents.get('reviewer')?.origin).toBe('claude');
    expect(ext.commands.get('ship')?.argumentHint).toBe('<env>');
    expect(ext.skills.get('deploy')?.description).toBe('How to deploy');
    expect(ext.mcpServers.get('local')?.config.command).toBe('node');
    expect(ext.instructions.map((i) => i.content).join()).toContain('Use tabs');
    // Built-in agents are always present.
    expect([...ext.agents.keys()]).toEqual(expect.arrayContaining(['create-tasks', 'run-phase', 'general-purpose']));
  });

  it('loads an enabled Claude plugin with namespaced commands, skills and MCP', () => {
    const pluginRoot = path.join(home, 'plug');
    write(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'toolkit', version: '1.2.3' }));
    write(path.join(pluginRoot, 'commands', 'audit.md'), 'Audit $ARGUMENTS');
    write(path.join(pluginRoot, 'skills', 'sec', 'SKILL.md'), '---\nname: sec\ndescription: Security\n---\nx');
    write(path.join(pluginRoot, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: '${CLAUDE_PLUGIN_ROOT}/bin/srv' } } }));
    write(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    write(
      path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'toolkit@market': [{ scope: 'user', installPath: pluginRoot }] } }),
    );
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ enabledPlugins: { 'toolkit@market': true }, permissions: { allow: ['Bash(ls:*)'] } }));

    const ext = loadExtensions({ cwd: root, root, settings: {} });
    expect(ext.plugins.map((p) => p.name)).toContain('toolkit');
    expect(ext.commands.has('toolkit:audit')).toBe(true);
    expect(ext.skills.has('toolkit:sec')).toBe(true);
    expect(ext.mcpServers.get('plugin_toolkit_srv')?.config.command).toBe(`${pluginRoot}/bin/srv`);
    expect(ext.hookSources.some((h) => h.origin === 'plugin:toolkit')).toBe(true);
    expect(ext.rules.allow).toContain('Bash(ls:*)');
  });

  it('ignores plugins that are not enabled', () => {
    const pluginRoot = path.join(home, 'plug2');
    write(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'off' }));
    write(path.join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'off@market': [{ scope: 'user', installPath: pluginRoot }] } }));
    const ext = loadExtensions({ cwd: root, root, settings: {} });
    expect(ext.plugins.length).toBe(0);
  });

  it('loads Codex MCP servers, skills and prompts', () => {
    write(path.join(process.env.CODEX_HOME!, 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n');
    write(path.join(process.env.CODEX_HOME!, 'skills', 'refactor', 'SKILL.md'), '---\nname: refactor\ndescription: Refactor\n---\nx');
    write(path.join(process.env.CODEX_HOME!, 'prompts', 'review.md'), 'Review $ARGUMENTS');
    const ext = loadExtensions({ cwd: root, root, settings: {} });
    expect(ext.mcpServers.get('docs')?.config.args).toEqual(['-y', 'docs-mcp']);
    expect(ext.skills.get('refactor')?.origin).toBe('codex');
    expect(ext.commands.get('review')?.origin).toBe('codex');
  });

  it('expands CLAUDE.md @imports and merges instruction files', () => {
    write(path.join(root, 'docs', 'style.md'), 'Use 2 spaces.');
    write(path.join(root, 'CLAUDE.md'), '# Rules\n@docs/style.md\n');
    write(path.join(root, 'AGENTS.md'), 'Agents rules here');
    const ext = loadExtensions({ cwd: root, root, settings: {} });
    const all = ext.instructions.map((i) => i.content).join('\n');
    expect(all).toContain('Use 2 spaces.');
    expect(all).toContain('Agents rules here');
  });

  it('lets alteran settings disable MCP servers and compat sources', () => {
    write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    write(path.join(process.env.CODEX_HOME!, 'config.toml'), '[mcp_servers.docs]\ncommand = "npx"\n');
    const ext = loadExtensions({ cwd: root, root, settings: { disabledMcpServers: ['a'], compat: { codex: false } } });
    expect(ext.mcpServers.has('a')).toBe(false);
    expect(ext.mcpServers.has('b')).toBe(true);
    expect(ext.mcpServers.has('docs')).toBe(false);
  });
});
