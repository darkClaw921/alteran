import { EventEmitter } from 'node:events';
import type { Message, Usage } from '../types.js';
import type { ToolOutput } from '../tools/types.js';
import type { PermissionMode } from '../config/settings.js';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type AgentEvent =
  | { type: 'agent_start'; agentId: string; label: string; parentId?: string; prompt?: string }
  | { type: 'agent_end'; agentId: string; label: string; ok: boolean; summary?: string }
  | { type: 'user_message'; agentId: string; text: string }
  | { type: 'text_delta'; agentId: string; text: string }
  | { type: 'thinking_delta'; agentId: string; text: string }
  | { type: 'assistant_message'; agentId: string; message: Message }
  | { type: 'tool_start'; agentId: string; id: string; name: string; input: Record<string, unknown>; summary: string }
  | { type: 'tool_end'; agentId: string; id: string; name: string; input: Record<string, unknown>; output: ToolOutput; durationMs: number }
  | {
      type: 'usage';
      agentId: string;
      model: string;
      turn: Usage;
      total: Usage;
      contextTokens: number;
      contextWindow: number;
      costUsd?: number;
    }
  | { type: 'status'; agentId: string; state: 'thinking' | 'streaming' | 'tool' | 'idle' | 'compacting'; detail?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'todos'; agentId: string; todos: TodoItem[] }
  | { type: 'tracker_changed' }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'model'; model: string }
  | { type: 'compact'; agentId: string; beforeTokens: number; afterTokens: number }
  | { type: 'plan_ready'; plan: string };

export class EventBus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit(ev: AgentEvent) {
    this.ee.emit('event', ev);
  }

  on(fn: (ev: AgentEvent) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
}
