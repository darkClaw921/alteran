import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRuntime as scriptedRuntime, textTurn, toolTurn, until, useTempDirs } from './scripted.js';
import type { StreamEvent } from '../src/types.js';

const dirs = useTempDirs('hooks');
const makeRuntime = (turns: StreamEvent[][], mode: 'autonomous' | 'default' | 'plan' = 'autonomous') => scriptedRuntime(dirs, turns, mode);
const dir = () => dirs.dir;

function configureHooks(hooks: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir(), '.alteran'), { recursive: true });
  fs.writeFileSync(path.join(dir(), '.alteran', 'settings.json'), JSON.stringify({ hooks }));
}

/**
 * A hook command that appends its stdin payload to `log`, and optionally prints a verdict. Single
 * quotes keep the shell out of the script, so the paths and JSON survive untouched.
 */
function recordCommand(log: string, verdict?: string): string {
  const script = `require("fs").appendFileSync(${JSON.stringify(log)}, require("fs").readFileSync(0,"utf8"));${verdict ? `process.stdout.write(JSON.stringify(${verdict}));` : ''}`;
  return `node -e '${script}'`;
}

function read(log: string): string | undefined {
  try {
    return fs.readFileSync(log, 'utf8');
  } catch {
    return undefined;
  }
}

describe('hooks', () => {
  it('runs the Notification hook when a turn ends', async () => {
    const log = path.join(dir(), 'notify.log');
    configureHooks({ Notification: [{ hooks: [{ type: 'command', command: recordCommand(log) }] }] });
    const { rt } = await makeRuntime([textTurn('ok')]);
    await rt.main.send('hello', new AbortController().signal);
    const text = await until(() => read(log));
    expect(text).toContain('"hook_event_name":"Notification"');
    expect(text).toContain('"notification_type":"idle"');
  });

  it('tells the Notification hook when a call blocks on approval', async () => {
    const log = path.join(dir(), 'approval.log');
    configureHooks({ Notification: [{ hooks: [{ type: 'command', command: recordCommand(log) }] }] });
    const { rt, provider } = await makeRuntime([toolTurn('w1', 'Write', { file_path: 'x.txt', content: 'hi' }), textTurn('done')], 'default');
    rt.ui = { askPermission: async () => ({ kind: 'allow_once' }) };
    await rt.main.send('write it', new AbortController().signal);
    expect(provider.requests.length).toBeGreaterThan(0);
    const text = await until(() => (read(log)?.includes('permission_request') ? read(log) : undefined));
    expect(text).toContain('needs approval to run Write');
  });

  it('stops the session when a hook answers continue:false', async () => {
    const log = path.join(dir(), 'stop.log');
    configureHooks({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: recordCommand(log, '{continue:false, stopReason:"stop now"}') }] }],
    });
    const { rt, provider, events } = await makeRuntime([textTurn('should never run')]);
    expect(await rt.main.send('hello', new AbortController().signal)).toBe('');
    // The model is never asked, and the session refuses further turns rather than quietly resuming.
    expect(provider.requests).toHaveLength(0);
    expect(await rt.main.send('again', new AbortController().signal)).toBe('');
    expect(provider.requests).toHaveLength(0);
    expect(events.some((e) => e.type === 'notice' && e.text.includes('stopped by hook'))).toBe(true);
  });

  it('adds the permission rules a hook hands back', async () => {
    const log = path.join(dir(), 'rules.log');
    const verdict =
      '{hookSpecificOutput:{permissionDecision:"allow",updatedPermissions:[{type:"addRules",behavior:"allow",rules:[{toolName:"Bash",ruleContent:"rm -rf /"}]}]}}';
    configureHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: recordCommand(log, verdict) }] }] });
    const { rt } = await makeRuntime([toolTurn('b1', 'Bash', { command: 'echo hi' }), textTurn('done')]);
    await rt.main.send('run it', new AbortController().signal);
    expect(rt.permissions.rules.allow).toContain('Bash(rm -rf /)');
    expect(rt.permissions.sessionAllow).toContain('Bash(rm -rf /)');
  });
});
