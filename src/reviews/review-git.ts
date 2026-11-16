/**
 * @fileoverview What the Reviews page reads from git: which branch a session is on, and what that branch changes
 * against its base. Read-only. Everything compares two COMMITS, so the working tree, the index and any clean
 * filter are never involved.
 *
 * Rules, shared with `git-workspace-status.ts` (whose runner this uses):
 * - argv only, a timeout, non-interactive, no external diff and no textconv driver;
 * - every ref is checked with `git check-ref-format` and passed as a full `refs/...` name or a sha, never as a
 *   word git could read as an option; every path follows `--`;
 * - the caller refuses a remote or Docker session, and a repository at or inside a Docker case workspace,
 *   before any function here runs.
 */
import { basename } from 'node:path';
import { isSafeRepoRelativePath, runGit, type GitRunner } from '../git-workspace-status.js';
import type { RepoFacts } from './review-model.js';

export const MAX_REVIEW_FILES = 500;
export const MAX_REVIEW_DIFF_BYTES = 400 * 1024;
const SHA = /^[0-9a-f]{40}$/;

export class ReviewGitRefusal extends Error {}

const line = (s: string): string => s.trim().split('\n')[0] ?? '';
async function tryGit(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

async function validRef(git: GitRunner, cwd: string, name: string): Promise<boolean> {
  return (await tryGit(git, cwd, ['check-ref-format', '--branch', name])) !== null;
}

/** The commit a branch name points at: the local branch first, then the one fetched from `origin`. */
async function resolveBranch(git: GitRunner, cwd: string, name: string): Promise<string | null> {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    const sha = line((await tryGit(git, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ?? '');
    if (SHA.test(sha)) return sha;
  }
  return null;
}

async function defaultBase(git: GitRunner, cwd: string): Promise<string | null> {
  const head = line((await tryGit(git, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])) ?? '');
  const fromOrigin = head.startsWith('origin/') ? head.slice('origin/'.length) : '';
  for (const name of [fromOrigin, 'main', 'master']) {
    if (name && (await resolveBranch(git, cwd, name))) return name;
  }
  return null;
}

/** The branch the session's folder has checked out, and the base it will be compared with. */
export async function repoFacts(
  cwd: string,
  wantedBase: string | undefined,
  git: GitRunner = runGit
): Promise<RepoFacts> {
  const repoRoot = line((await tryGit(git, cwd, ['rev-parse', '--show-toplevel'])) ?? '');
  if (!repoRoot) throw new ReviewGitRefusal('NOT_A_REPO: this session is not inside a git repository');
  const branch = line((await tryGit(git, repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? '');
  if (!branch || !(await validRef(git, repoRoot, branch)))
    throw new ReviewGitRefusal('NO_BRANCH: check out the branch to review; a detached HEAD cannot be reviewed');
  const headSha = line((await tryGit(git, repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) ?? '');
  if (!SHA.test(headSha)) throw new ReviewGitRefusal('NO_COMMITS: this branch has no commit yet');
  const base = wantedBase ?? (await defaultBase(git, repoRoot));
  if (!base) throw new ReviewGitRefusal('NO_BASE: no main or master branch was found; pass --base <branch>');
  if (!(await validRef(git, repoRoot, base)) || !(await resolveBranch(git, repoRoot, base)))
    throw new ReviewGitRefusal(`NO_BASE: the base branch ${base} does not exist in this repository`);
  if (base === branch)
    throw new ReviewGitRefusal(`SAME_BRANCH: ${branch} is the base branch; commit the work on its own branch`);
  return { repoRoot, project: basename(repoRoot), branch, base, headSha };
}

export type ChangedFile = { path: string; origPath?: string; added: number; deleted: number; binary: boolean };
export type ReviewChanges = {
  /** The branch tip now. Differs from the review's `headSha` once the branch has moved. */
  headSha: string;
  mergeBase: string;
  commits: number;
  files: ChangedFile[];
  added: number;
  deleted: number;
  /** More files changed than are listed. */
  truncated: boolean;
  /** The branch no longer exists; the lists are empty. */
  gone: boolean;
};

/** Parses `git diff --numstat -z`: `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`. */
export function parseNumstatZ(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] ?? '');
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const counts = { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary };
    if (m[3]) files.push({ path: m[3], ...counts });
    else {
      const origPath = parts[i + 1] ?? '';
      const path = parts[i + 2] ?? '';
      i += 2;
      if (path) files.push({ path, origPath, ...counts });
    }
  }
  return files.filter((f) => isSafeRepoRelativePath(f.path) && (!f.origPath || isSafeRepoRelativePath(f.origPath)));
}

type Range = { head: string; mergeBase: string } | null;
async function rangeOf(git: GitRunner, repoRoot: string, base: string, branch: string): Promise<Range> {
  if (!(await validRef(git, repoRoot, base)) || !(await validRef(git, repoRoot, branch))) return null;
  const head = await resolveBranch(git, repoRoot, branch);
  const baseSha = await resolveBranch(git, repoRoot, base);
  if (!head || !baseSha) return null;
  const mergeBase = line((await tryGit(git, repoRoot, ['merge-base', baseSha, head])) ?? '');
  return SHA.test(mergeBase) ? { head, mergeBase } : null;
}

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];

export async function reviewChanges(
  repoRoot: string,
  base: string,
  branch: string,
  git: GitRunner = runGit
): Promise<ReviewChanges> {
  const range = await rangeOf(git, repoRoot, base, branch);
  if (!range)
    return { headSha: '', mergeBase: '', commits: 0, files: [], added: 0, deleted: 0, truncated: false, gone: true };
  const all = parseNumstatZ(await git(repoRoot, [...DIFF, '--numstat', '-z', range.mergeBase, range.head, '--']));
  const commits =
    Number(line((await tryGit(git, repoRoot, ['rev-list', '--count', `${range.mergeBase}..${range.head}`])) ?? '')) ||
    0;
  return {
    headSha: range.head,
    mergeBase: range.mergeBase,
    commits,
    files: all.slice(0, MAX_REVIEW_FILES),
    added: all.reduce((n, f) => n + f.added, 0),
    deleted: all.reduce((n, f) => n + f.deleted, 0),
    truncated: all.length > MAX_REVIEW_FILES,
    gone: false,
  };
}

export type ReviewFileDiff = { diff: string; truncated: boolean; binary: boolean };

/** One file's diff between the merge base and the branch tip. `path` must be a path `reviewChanges` listed. */
export async function reviewFileDiff(
  repoRoot: string,
  base: string,
  branch: string,
  file: { path: string; origPath?: string },
  git: GitRunner = runGit
): Promise<ReviewFileDiff | null> {
  if (!isSafeRepoRelativePath(file.path) || (file.origPath && !isSafeRepoRelativePath(file.origPath))) return null;
  const range = await rangeOf(git, repoRoot, base, branch);
  if (!range) return null;
  const paths = file.origPath ? [file.origPath, file.path] : [file.path];
  let out: string;
  let cutShort = false;
  try {
    out = await git(repoRoot, [...DIFF, '-U3', range.mergeBase, range.head, '--', ...paths]);
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    if (e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || typeof e.stdout !== 'string') throw err;
    out = e.stdout;
    cutShort = true;
  }
  const binary = /^Binary files .* differ$/m.test(out) || /^GIT binary patch$/m.test(out);
  if (out.length <= MAX_REVIEW_DIFF_BYTES) return { diff: out, truncated: cutShort, binary };
  const cut = out.lastIndexOf('\n', MAX_REVIEW_DIFF_BYTES);
  return { diff: out.slice(0, cut > 0 ? cut : MAX_REVIEW_DIFF_BYTES), truncated: true, binary };
}
