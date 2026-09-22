import { execFile } from 'node:child_process';
import path from 'node:path';

export interface GitFile {
  status: string;
  path: string;
  added: number;
  removed: number;
}

export interface GitInfo {
  isRepo: boolean;
  repo: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  head: string;
  dirty: boolean;
  files: GitFile[];
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

export async function readGit(cwd: string): Promise<GitInfo> {
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  if (!top) return { isRepo: false, repo: path.basename(cwd), branch: '-', ahead: 0, behind: 0, head: '-', dirty: false, files: [] };
  const [branch, head, upstream, status, numstat, cachedNumstat, remote] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', '--short', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(cwd, ['status', '--porcelain=v1', '-uall']),
    git(cwd, ['diff', '--numstat']),
    git(cwd, ['diff', '--cached', '--numstat']),
    git(cwd, ['remote', 'get-url', 'origin']),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream.trim()) {
    const lr = (await git(cwd, ['rev-list', '--left-right', '--count', `${upstream.trim()}...HEAD`])).trim().split(/\s+/);
    behind = Number(lr[0]) || 0;
    ahead = Number(lr[1]) || 0;
  }
  const stats = new Map<string, { a: number; d: number }>();
  for (const l of (numstat + cachedNumstat).split('\n')) {
    const [a, d, f] = l.split('\t');
    if (!f) continue;
    const prev = stats.get(f) ?? { a: 0, d: 0 };
    stats.set(f, { a: prev.a + (Number(a) || 0), d: prev.d + (Number(d) || 0) });
  }
  const files: GitFile[] = [];
  for (const l of status.split('\n')) {
    if (!l.trim()) continue;
    const st = l.slice(0, 2).trim() || '?';
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    const s = stats.get(p);
    files.push({ status: st, path: p, added: s?.a ?? 0, removed: s?.d ?? 0 });
  }
  const untracked = files.filter((f) => f.status === '??' && !f.added);
  await Promise.all(
    untracked.slice(0, 20).map(async (f) => {
      const out = await git(top, ['diff', '--no-index', '--numstat', '/dev/null', f.path]);
      f.added = Number(out.split('\t')[0]) || 0;
    }),
  );
  const repoName = remote.trim() ? remote.trim().replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/') : path.basename(top);
  return {
    isRepo: true,
    repo: repoName,
    branch: branch.trim() || '(detached)',
    upstream: upstream.trim() || undefined,
    ahead,
    behind,
    head: head.trim() || '(none)',
    dirty: files.length > 0,
    files,
  };
}

export async function gitDiff(cwd: string): Promise<string> {
  const [unstaged, staged] = await Promise.all([git(cwd, ['diff', '--no-color']), git(cwd, ['diff', '--cached', '--no-color'])]);
  return [staged, unstaged].filter((s) => s.trim()).join('\n');
}
