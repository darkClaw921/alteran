import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
/** Resolved lazily so tests and env overrides can redirect them. */
export const alteranHome = () => process.env.ALTERAN_HOME ?? path.join(HOME, '.alteran');
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(HOME, '.claude');
export const codexHome = () => process.env.CODEX_HOME ?? path.join(HOME, '.codex');

export function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

/** Walk up from `start` looking for a directory containing `marker`. */
export function findUp(start: string, marker: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Project root: nearest git repository, else cwd. */
export function projectRoot(cwd: string): string {
  return findUp(cwd, '.git') ?? path.resolve(cwd);
}

let pkgRoot: string | null = null;
/** Root of the installed alteran package (holds `assets/`). Works from src/ and dist/. */
export function packageRoot(): string {
  if (pkgRoot) return pkgRoot;
  const here = path.dirname(fileURLToPath(import.meta.url));
  pkgRoot = findUp(here, 'package.json') ?? here;
  return pkgRoot;
}

export const assetPath = (...parts: string[]) => path.join(packageRoot(), 'assets', ...parts);

export function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Filesystem-safe slug of a project path for per-project storage. */
export function projectSlug(dir: string): string {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]+/g, '-');
}
