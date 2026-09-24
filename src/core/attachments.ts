import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ContentBlock, ImageBlock } from '../types.js';

/** Media types the providers accept, keyed by extension. */
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Same ceiling the Read tool uses: past this a request is better spent on text. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type Loaded = { block: ImageBlock; file: string } | { error: string };

/** Turn an image file into a block the providers understand, or say why it cannot be one. */
export function loadImage(file: string): Loaded {
  const ext = path.extname(file).toLowerCase();
  const mediaType = IMAGE_TYPES[ext];
  if (!mediaType) return { error: `${file} is not an image (${Object.keys(IMAGE_TYPES).join(', ')})` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { error: `No such file: ${file}` };
  }
  if (!stat.isFile()) return { error: `${file} is not a file` };
  if (stat.size > MAX_IMAGE_BYTES) return { error: `${file} is ${Math.round(stat.size / 1024 / 1024)}MB; images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024}MB` };
  try {
    return { block: { type: 'image', mediaType, data: fs.readFileSync(file).toString('base64') }, file };
  } catch (e) {
    return { error: `Could not read ${file}: ${(e as Error).message}` };
  }
}

/**
 * Image files named in a message with `@`, the same way `@src/x.ts` mentions a file. Only images
 * are lifted out here: every other `@path` belongs to whoever expands file mentions, and a path
 * that does not resolve is left in the text untouched rather than silently swallowed.
 */
export function imageRefs(text: string, cwd: string): { text: string; images: Loaded[] } {
  const images: Loaded[] = [];
  const out = text.replace(/(^|\s)@([\w./~-]+\.[A-Za-z0-9]+)/g, (full, pre: string, ref: string) => {
    if (!IMAGE_TYPES[path.extname(ref).toLowerCase()]) return full;
    const resolved = path.resolve(cwd, ref.startsWith('~/') ? path.join(process.env.HOME ?? '', ref.slice(2)) : ref);
    const loaded = loadImage(resolved);
    images.push(loaded);
    // A path that would not load is a typo worth surfacing, not a mention worth sending on.
    return 'error' in loaded ? `${pre}[image not attached: ${loaded.error}]` : `${pre}[image attached: ${ref}]`;
  });
  return { text: out, images };
}

/**
 * The image on the clipboard, as a block. There is no portable way to ask for it: macOS needs
 * `pngpaste` (or nothing), Wayland `wl-paste`, X11 `xclip`. When none is installed the answer is a
 * hint, never an empty attachment that would look like it worked.
 */
export function clipboardImage(env: NodeJS.ProcessEnv = process.env): { block: ImageBlock; source: string } | { error: string } {
  const attempts: Array<{ cmd: string; args: string[]; source: string }> = [];
  if (process.platform === 'darwin') attempts.push({ cmd: 'pngpaste', args: ['-'], source: 'pngpaste' });
  if (process.platform === 'linux' && env.WAYLAND_DISPLAY) attempts.push({ cmd: 'wl-paste', args: ['-t', 'image/png'], source: 'wl-paste' });
  if (process.platform === 'linux') attempts.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], source: 'xclip' });
  if (!attempts.length) return { error: `Reading an image from the clipboard is not supported on ${process.platform}. Pass a path instead.` };

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const data = execFileSync(attempt.cmd, attempt.args, { maxBuffer: MAX_IMAGE_BYTES, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (data.length) return { block: { type: 'image', mediaType: 'image/png', data: data.toString('base64') }, source: attempt.source };
      failures.push(`${attempt.cmd}: clipboard holds no image`);
    } catch {
      failures.push(`${attempt.cmd}: not available or no image on the clipboard`);
    }
  }
  return { error: `Could not read an image from the clipboard (${failures.join('; ')}). Pass a path instead.` };
}

/** Blocks for the images queued for the next message, dropping the ones that no longer load. */
export function drainImages(files: string[]): { blocks: ImageBlock[]; errors: string[] } {
  const blocks: ImageBlock[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const loaded = loadImage(file);
    if ('error' in loaded) errors.push(loaded.error);
    else blocks.push(loaded.block);
  }
  return { blocks, errors };
}

/** One-line note describing what is riding along with a message, for the console. */
export function describeImages(blocks: ContentBlock[]): string | undefined {
  const images = blocks.filter((b): b is ImageBlock => b.type === 'image');
  if (!images.length) return undefined;
  const kb = Math.round(images.reduce((n, i) => n + i.data.length * 0.75, 0) / 1024);
  return `${images.length} image${images.length === 1 ? '' : 's'} attached (~${kb}KB)`;
}
