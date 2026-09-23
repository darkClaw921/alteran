import type { Entry } from './store.js';

/**
 * The transcript as markdown.
 *
 * Entries that carry text a person wrote or read (their prompt, the answer, a notice) become
 * paragraphs; tool calls become a list line so the shape of the work is visible without the noise;
 * thinking stays a blockquote, because it is context for the answer rather than the answer.
 */
export function transcriptMarkdown(entries: readonly Entry[], meta: { id?: string; model?: string; date?: Date } = {}): string {
  const head = ['# alteran session'];
  if (meta.id) head[0] += ` ${meta.id.slice(0, 8)}`;
  const facts = [meta.date ? meta.date.toISOString().replace('T', ' ').slice(0, 16) : '', meta.model ?? ''].filter(Boolean);
  if (facts.length) head.push('', `_${facts.join(' · ')}_`);

  const body: string[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        body.push(section('You', e.text));
        break;
      case 'assistant':
        if (e.text.trim()) body.push(section('alteran', e.text));
        break;
      case 'thinking':
        body.push(blockquote(e.text));
        break;
      case 'tool': {
        const state = e.status === 'error' ? ' ❌' : '';
        const summary = e.summary ? ` \`${e.summary}\`` : '';
        const duration = e.durationMs ? ` _(${(e.durationMs / 1000).toFixed(1)}s)_` : '';
        body.push(`- **${e.name}**${summary}${duration}${state}`);
        break;
      }
      case 'agent': {
        const label = e.name ?? e.label;
        body.push(`- **agent ${label}** — ${e.status}${e.summary ? `: ${firstLine(e.summary)}` : ''}`);
        break;
      }
      case 'notice':
        body.push(`> ${asQuote(e.text)}`);
        break;
      case 'info':
        body.push(section(e.title ?? 'info', e.text));
        break;
      case 'error':
        body.push(section('error', e.text));
        break;
      case 'plan':
        body.push(`## Plan\n\n${e.text}`);
        break;
      case 'diff':
        body.push(`### Diff\n\n\`\`\`diff\n${e.text}\n\`\`\``);
        break;
      default:
        break;
    }
  }
  return [...head, '', ...body].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** The last `count` assistant answers, as they would be pasted into a chat. */
export function lastAnswers(entries: readonly Entry[], count: number): string {
  const answers = entries.filter((e): e is Extract<Entry, { kind: 'assistant' }> => e.kind === 'assistant' && Boolean(e.text.trim()));
  return answers.slice(Math.max(0, answers.length - count)).map((e) => e.text.trim()).join('\n\n---\n\n');
}

function section(title: string, text: string): string {
  return `## ${title}\n\n${text.trim()}`;
}

function blockquote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** A multi-line notice inside a blockquote needs every line prefixed, or it breaks out of it. */
function asQuote(text: string): string {
  return text.trim().replace(/\n/g, '\n> ');
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 200);
}
