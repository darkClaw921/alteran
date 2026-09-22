import YAML from 'yaml';

export interface Parsed<T = Record<string, unknown>> {
  data: T;
  body: string;
}

/** Parse `---\nyaml\n---\nbody` markdown. Tolerates the loose YAML Claude agent files often contain. */
export function parseFrontmatter<T = Record<string, unknown>>(text: string): Parsed<T> {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {} as T, body: text };
  const [, yaml, body] = m;
  try {
    const data = YAML.parse(yaml) ?? {};
    return { data: data as T, body };
  } catch {
    return { data: looseParse(yaml) as T, body };
  }
}

/** Fallback: `key: value` per line, value taken verbatim (handles unquoted colons and escapes). */
function looseParse(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) {
      key = m[1];
      out[key] = m[2].replace(/^["']|["']$/g, '');
    } else if (key && line.trim()) {
      out[key] += '\n' + line.trim();
    }
  }
  return out;
}

export function toList(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
