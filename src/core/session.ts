import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { alteranHome, projectSlug } from '../config/paths.js';
import type { Message } from '../types.js';

export interface SessionMeta {
  type: 'meta';
  id: string;
  cwd: string;
  root: string;
  model: string;
  createdAt: string;
  title?: string;
}

type Line = SessionMeta | { type: 'message'; message: Message } | { type: 'reset'; reason: 'compact' | 'clear' };

export interface SessionSummary {
  id: string;
  file: string;
  title: string;
  updatedAt: Date;
  messages: number;
}

export class SessionStore {
  readonly id: string;
  readonly file: string;
  private titled = false;

  constructor(
    private root: string,
    meta: Omit<SessionMeta, 'type' | 'id' | 'createdAt'>,
    id?: string,
  ) {
    this.id = id ?? crypto.randomUUID();
    const dir = SessionStore.dir(root);
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${this.id}.jsonl`);
    if (!fs.existsSync(this.file)) {
      this.write({ type: 'meta', id: this.id, createdAt: new Date().toISOString(), ...meta });
    } else {
      this.titled = true;
    }
  }

  static dir(root: string) {
    return path.join(alteranHome(), 'sessions', projectSlug(root));
  }

  private write(line: Line) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
    } catch {}
  }

  append(message: Message) {
    if (!this.titled && message.role === 'user') {
      const text = message.content.find((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>'));
      if (text && text.type === 'text') {
        this.titled = true;
        this.write({ type: 'meta', id: this.id, cwd: '', root: this.root, model: '', createdAt: new Date().toISOString(), title: text.text.slice(0, 100) });
      }
    }
    this.write({ type: 'message', message });
  }

  reset(reason: 'compact' | 'clear') {
    this.write({ type: 'reset', reason });
  }

  /** Messages after the last reset marker. */
  static load(file: string): { messages: Message[]; meta?: SessionMeta } {
    const messages: Message[] = [];
    let meta: SessionMeta | undefined;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        const line = JSON.parse(raw) as Line;
        if (line.type === 'meta') meta = meta ? { ...meta, title: line.title ?? meta.title } : line;
        else if (line.type === 'reset') messages.length = 0;
        else if (line.type === 'message') messages.push(line.message);
      } catch {}
    }
    return { messages: sanitizeHistory(messages), meta };
  }

  static list(root: string): SessionSummary[] {
    const dir = SessionStore.dir(root);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(dir, f);
        const { messages, meta } = SessionStore.load(file);
        return { id: f.replace(/\.jsonl$/, ''), file, title: meta?.title ?? '(untitled)', updatedAt: fs.statSync(file).mtime, messages: messages.length };
      })
      .filter((s) => s.messages > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}

/** Drop a trailing assistant tool_use without results (session cut mid-tool) so the history stays valid. */
function sanitizeHistory(messages: Message[]): Message[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) out.pop();
  return out;
}
