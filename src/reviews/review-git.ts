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
import { runFetch } from '../git-fetch.js';
import { isSafeRepoRelativePath, runGit, type GitRunner } from '../git-workspace-status.js';
import { sourceOf, type RepoFacts, type Review } from './review-model.js';

export const MAX_REVIEW_FILES = 500;
export const MAX_REVIEW_DIFF_BYTES = 400 * 1024;
export const SHA = /^[0-9a-f]{40}$/;
/** How long one fetch or push to `origin` may take. */
export const NETWORK_TIMEOUT_MS = 60_000;

export class ReviewGitRefusal extends Error {}

export const line = (s: string): string => s.trim().split('\n')[0] ?? '';
export async function tryGit(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function validRef(git: GitRunner, cwd: string, name: string): Promise<boolean> {
  return (await tryGit(git, cwd, ['check-ref-format', '--branch', name])) !== null;
}

/**
 * Where a review's head branch is read. A session's review reads the session's own branch, then the one fetched from
 * `origin`; a review of a pull request reads `origin` only, so a stale local branch of the same name never shadows the
 * pull request's tip.
 */
export type HeadLocator = { from: 'local-first'; branch: string } | { from: 'origin'; branch: string };

const headRefs = (head: HeadLocator): string[] =>
  head.from === 'origin'
    ? [`refs/remotes/origin/${head.branch}`]
    : [`refs/heads/${head.branch}`, `refs/remotes/origin/${head.branch}`];

/** The commit a head points at, or null. The one head lookup: the Changes tab and Approve both read through it. */
export async function resolveHead(git: GitRunner, cwd: string, head: HeadLocator): Promise<string | null> {
  for (const ref of headRefs(head)) {
    const sha = line((await tryGit(git, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ?? '');
    if (SHA.test(sha)) return sha;
  }
  return null;
}
/** Where a review's head is read: a work review's pull request lives on origin, a session's branch here first. */
export const headOf = (review: Pick<Review, 'sessionId' | 'sessionName' | 'branch'>): HeadLocator =>
  sourceOf(review).kind === 'work'
    ? { from: 'origin', branch: review.branch }
    : { from: 'local-first', branch: review.branch };

const resolveBranch = (git: GitRunner, cwd: string, name: string): Promise<string | null> =>
  resolveHead(git, cwd, { from: 'local-first', branch: name });

/**
 * Brings `refs/remotes/origin/<branch>` up to date with `origin`, through the fetch runner (non-interactive, timed,
 * the whole process tree killed on timeout). `absent`: origin has no such branch, or there is no origin.
 */
export async function fetchHead(
  repoRoot: string,
  branch: string,
  deps: { git?: GitRunner; net?: GitRunner } = {}
): Promise<'fetched' | 'absent' | 'failed'> {
  const git = deps.git ?? runGit;
  if (!(await validRef(git, repoRoot, branch))) return 'failed';
  if ((await tryGit(git, repoRoot, ['remote', 'get-url', 'origin'])) === null) return 'absent';
  try {
    await (deps.net ?? runFetch)(
      repoRoot,
      ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { timeoutMs: NETWORK_TIMEOUT_MS }
    );
    return 'fetched';
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return typeof stderr === 'string' && /couldn't find remote ref/i.test(stderr) ? 'absent' : 'failed';
  }
}

/** The branch a review compares with when none is named: origin's default, then `main`, then `master`. */
export async function defaultBase(git: GitRunner, cwd: string): Promise<string | null> {
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
async function rangeOf(git: GitRunner, repoRoot: string, base: string, at: HeadLocator): Promise<Range> {
  if (!(await validRef(git, repoRoot, base)) || !(await validRef(git, repoRoot, at.branch))) return null;
  const head = await resolveHead(git, repoRoot, at);
  if (!head) return null;
  // The base branch here and the one fetched from `origin` can differ: merges land on the remote, so the local
  // branch is often behind. Comparing with the older one shows everything merged since as this branch's work, so the
  // fork point nearest the branch tip wins.
  let mergeBase = '';
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    const found = line((await tryGit(git, repoRoot, ['merge-base', ref, head])) ?? '');
    if (!SHA.test(found)) continue;
    if (!mergeBase || (await tryGit(git, repoRoot, ['merge-base', '--is-ancestor', mergeBase, found])) !== null)
      mergeBase = found;
  }
  return mergeBase ? { head, mergeBase } : null;
}

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];

export async function reviewChanges(
  repoRoot: string,
  base: string,
  head: HeadLocator,
  git: GitRunner = runGit
): Promise<ReviewChanges> {
  const range = await rangeOf(git, repoRoot, base, head);
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
  head: HeadLocator,
  file: { path: string; origPath?: string },
  git: GitRunner = runGit
): Promise<ReviewFileDiff | null> {
  if (!isSafeRepoRelativePath(file.path) || (file.origPath && !isSafeRepoRelativePath(file.origPath))) return null;
  const range = await rangeOf(git, repoRoot, base, head);
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

/** The changed files the page can show rendered, and how large one may be. Matched on the branch's own path. */
export const REVIEW_DOC_PATH = /\.(md|markdown)$/i;
export const MAX_REVIEW_DOC_BYTES = 400 * 1024;
export const isReviewDoc = (path: string): boolean => REVIEW_DOC_PATH.test(path);

export type ReviewFileText =
  | { kind: 'text'; text: string; headSha: string }
  | { kind: 'absent' }
  | { kind: 'too-large'; bytes: number };

/**
 * One Markdown file as the branch tip has it, for the rendered view. `path` must be a path `reviewChanges` listed.
 * The blob is read by sha (`cat-file`), so no filter, textconv or working tree is involved. A file the branch deletes
 * is `absent`; null means the branch is gone.
 */
export async function reviewFileText(
  repoRoot: string,
  base: string,
  head: HeadLocator,
  file: { path: string },
  git: GitRunner = runGit
): Promise<ReviewFileText | null> {
  if (!isSafeRepoRelativePath(file.path) || !isReviewDoc(file.path)) return null;
  const range = await rangeOf(git, repoRoot, base, head);
  if (!range) return null;
  const spec = `${range.head}:${file.path}`;
  if (line((await tryGit(git, repoRoot, ['cat-file', '-t', spec])) ?? '') !== 'blob') return { kind: 'absent' };
  const bytes = Number(line((await tryGit(git, repoRoot, ['cat-file', '-s', spec])) ?? ''));
  if (!Number.isInteger(bytes) || bytes < 0) return { kind: 'absent' };
  if (bytes > MAX_REVIEW_DOC_BYTES) return { kind: 'too-large', bytes };
  return { kind: 'text', text: await git(repoRoot, ['cat-file', 'blob', spec]), headSha: range.head };
}
