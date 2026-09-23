import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { lineDiff, plural } from './diff.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function resolvePath(ctx: ToolContext, p: string): string {
  const expanded = p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p;
  return path.resolve(ctx.runtime.cwd, expanded);
}

export function displayPath(ctx: ToolContext, abs: string): string {
  const rel = path.relative(ctx.runtime.cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

function mtime(file: string): number {
  return fs.statSync(file).mtimeMs;
}

/** Edits must be based on the current content: the file has to be read first and unchanged since. */
function checkFresh(ctx: ToolContext, file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const seen = ctx.runtime.fileState.get(file);
  if (seen === undefined) return `File has not been read yet. Read ${file} before editing it.`;
  if (mtime(file) > seen + 1) return `File ${file} was modified since it was last read. Read it again before editing.`;
  return null;
}

function markSeen(ctx: ToolContext, file: string) {
  ctx.runtime.fileState.set(file, mtime(file));
}

export const ReadTool: Tool<{ file_path: string; offset?: number; limit?: number }> = {
  name: 'Read',
  category: 'read',
  readOnly: true,
  description: `Reads a file from the local filesystem. file_path may be absolute or relative to the working directory.
- By default reads up to ${MAX_LINES} lines from the start; use offset (1-based line) and limit for large files.
- Output uses cat -n format (line number + tab). Lines longer than ${MAX_LINE_LEN} chars are truncated.
- Images (png, jpg, gif, webp) are returned visually.
- Reading a directory is an error: use Glob or Bash ls.
- You must Read a file before editing or overwriting it.`,
  schema: z.object({
    file_path: z.string().describe('Path of the file to read'),
    offset: z.number().int().min(1).optional().describe('1-based line to start from'),
    limit: z.number().int().min(1).optional().describe('Number of lines to read'),
  }),
  summarize: (i) => i.file_path,
  async run(input, ctx) {
    const file = resolvePath(ctx, input.file_path);
    if (!fs.existsSync(file)) return fail(`File does not exist: ${file}`);
    const st = fs.statSync(file);
    if (st.isDirectory()) return fail(`${file} is a directory. Use Glob or Bash ls to list it.`);
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (st.size > 5 * 1024 * 1024) return fail(`Image too large (${st.size} bytes)`);
      markSeen(ctx, file);
      return ok([{ type: 'image', mediaType: IMAGE_TYPES[ext], data: fs.readFileSync(file).toString('base64') }], {
        summary: `Read image (${Math.round(st.size / 1024)}KB)`,
      });
    }
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return fail(`${file} looks like a binary file.`);
    const text = buf.toString('utf8');
    markSeen(ctx, file);
    if (!text) return ok('<system-reminder>The file exists but is empty.</system-reminder>', { summary: 'Read 0 lines (empty)' });
    const all = text.split('\n');
    if (all[all.length - 1] === '') all.pop();
    const start = (input.offset ?? 1) - 1;
    const slice = all.slice(start, start + (input.limit ?? MAX_LINES));
    const width = String(start + slice.length).length;
    const body = slice
      .map((l, i) => {
        const line = l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…[truncated]' : l;
        return `${String(start + i + 1).padStart(Math.max(width, 5))}\t${line}`;
      })
      .join('\n');
    const more = start + slice.length < all.length ? `\n\n(${all.length - start - slice.length} more lines; use offset to continue)` : '';
    return ok(body + more, { summary: `Read ${plural(slice.length, 'line')}` });
  },
};

export const WriteTool: Tool<{ file_path: string; content: string }> = {
  name: 'Write',
  category: 'write',
  description: `Writes a file, creating parent directories as needed and overwriting existing content.
- An existing file must be Read first. Prefer Edit for changes to existing files.
- Do not create documentation files unless asked.`,
  schema: z.object({
    file_path: z.string().describe('Path of the file to write'),
    content: z.string().describe('Full file content'),
  }),
  summarize: (i) => i.file_path,
  async run(input, ctx) {
    const file = resolvePath(ctx, input.file_path);
    const stale = checkFresh(ctx, file);
    if (stale) return fail(stale);
    const existed = fs.existsSync(file);
    const before = existed ? fs.readFileSync(file, 'utf8') : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input.content);
    markSeen(ctx, file);
    const d = lineDiff(before, input.content);
    const lines = input.content.split('\n').length;
    return ok(existed ? `Updated ${file}` : `Created ${file} (${lines} lines)`, {
      summary: existed
        ? `Wrote ${displayPath(ctx, file)} with ${plural(d.added, 'addition')} and ${plural(d.removed, 'removal')}`
        : `Created ${displayPath(ctx, file)} (${plural(lines, 'line')})`,
      diff: d.lines.slice(0, 400),
    });
  },
};

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function applyEdit(content: string, e: EditSpec): { result: string } | { error: string } {
  if (e.old_string === e.new_string) return { error: 'old_string and new_string are identical.' };
  if (e.old_string === '') return { error: 'old_string is empty; use Write to create files.' };
  const count = content.split(e.old_string).length - 1;
  if (count === 0) return { error: `old_string not found in file:\n${e.old_string.slice(0, 500)}` };
  if (count > 1 && !e.replace_all) return { error: `old_string matches ${count} times. Add surrounding context to make it unique, or set replace_all.` };
  return {
    result: e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, () => e.new_string),
  };
}

async function editFile(ctx: ToolContext, filePath: string, edits: EditSpec[]) {
  const file = resolvePath(ctx, filePath);
  if (!fs.existsSync(file)) return fail(`File does not exist: ${file}`);
  const stale = checkFresh(ctx, file);
  if (stale) return fail(stale);
  const before = fs.readFileSync(file, 'utf8');
  let content = before;
  for (const [i, e] of edits.entries()) {
    const r = applyEdit(content, e);
    if ('error' in r) return fail(edits.length > 1 ? `Edit ${i + 1}: ${r.error}` : r.error);
    content = r.result;
  }
  fs.writeFileSync(file, content);
  markSeen(ctx, file);
  const d = lineDiff(before, content);
  const rel = displayPath(ctx, file);
  return ok(`Updated ${file} (${plural(edits.length, 'edit')} applied)`, {
    summary: `Updated ${rel} with ${plural(d.added, 'addition')} and ${plural(d.removed, 'removal')}`,
    diff: d.lines.slice(0, 400),
  });
}

const editSchema = z.object({
  file_path: z.string().describe('Path of the file to modify'),
  old_string: z.string().describe('Exact text to replace (must be unique unless replace_all)'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence'),
});

export const EditTool: Tool<z.infer<typeof editSchema>> = {
  name: 'Edit',
  category: 'write',
  description: `Performs an exact string replacement in a file.
- The file must be Read first in this session. Preserve exact indentation; strip the line-number prefix from Read output.
- Fails if old_string is not unique; add context or use replace_all.`,
  schema: editSchema,
  summarize: (i) => i.file_path,
  run: (input, ctx) => editFile(ctx, input.file_path, [input]),
};

const multiSchema = z.object({
  file_path: z.string(),
  edits: z.array(z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() })).min(1),
});

export const MultiEditTool: Tool<z.infer<typeof multiSchema>> = {
  name: 'MultiEdit',
  category: 'write',
  description: 'Applies several exact string replacements to one file atomically, in order. Same rules as Edit; if any edit fails none are applied.',
  schema: multiSchema,
  summarize: (i) => `${i.file_path}, ${plural(i.edits.length, 'edit')}`,
  run: (input, ctx) => editFile(ctx, input.file_path, input.edits),
};
