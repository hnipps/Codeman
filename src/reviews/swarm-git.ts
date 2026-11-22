/**
 * @fileoverview What a pr-swarm run on a review does in git: read the branch tip the run reviews, make the run's
 * detached worktree at that tip, and remove it again (`intent/2026-11-20-pr-swarm-reviews.md`).
 *
 * The rules are `review-git.ts`'s: argv only, every ref checked, no git on a remote or Docker case or inside a Docker
 * case workspace (the caller refuses those first, and the worktree functions refuse a Docker workspace again). The
 * worktree is a managed one (`<repo>/.claude/worktrees/swarm-<runId>`), made and removed by the same functions the
 * worktree routes use, so it is never forced away and a name is always recognisable as a run's.
 *
 * The tip watcher's reads (`watchTipReader()`) go through the fetch runner, so every git process they start is
 * non-interactive and is killed with its whole process tree when the read's deadline passes.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDetachedWorktree,
  removeCaseWorktree,
  resolveCaseRepository,
  type WorktreeGitRunner,
} from '../git-worktrees.js';
import { runFetch } from '../git-fetch.js';
import { isSafeRepoRelativePath, runGit, type GitRunner } from '../git-workspace-status.js';
import { fetchHead, forkPoint, line, MAX_REVIEW_DOC_BYTES, resolveHead, SHA, tryGit, validRef } from './review-git.js';
import { sourceOf, type Review, type WorkRef } from './review-model.js';
import { attributedSpec, isSpecReview } from './swarm-model.js';
import type { TipReader } from './swarm-watcher.js';

/** Where a run pushes the triage's fix commits: `origin`, or this repository (`.`) for a branch origin does not have. */
export type PushRemote = 'origin' | '.';
/** The branch tip a run reviews, and where that tip lives. */
export type RunTip = { sha: string; remote: PushRemote };

/** Why a run gets the review half only. */
export type ReviewOnlyReason = 'spec' | 'checked-out';
/** What the run's session is told to do, decided once at start from the repository. */
export type RunPlan = {
  workingDir: string;
  /** The fork point of the reviewed tip from the review's base: the run diffs `<base>...HEAD`. */
  base: string;
  /** `null`: the full triage. Otherwise why it is review only. */
  reviewOnly: ReviewOnlyReason | null;
};

export type SwarmGitDeps = {
  git?: GitRunner;
  worktreeGit?: WorktreeGitRunner;
  net?: GitRunner;
  /** Host paths of Docker case workspaces; git never runs at or inside one. */
  dockerWorkspaces: string[];
  /** The registry's agent skill folders, excluded in the worktree so it stays removable. */
  agentSkillDirs?: readonly string[];
};

export const runWorktreeName = (runId: string): string => `swarm-${runId}`;

/**
 * The tip a run reviews, read the way the tip watcher reads it: `origin`'s branch when origin has it, otherwise a
 * session review's own local branch. A work review lives on origin only. Null when it cannot be read.
 */
export async function readRunTip(
  review: Review,
  deps: Omit<SwarmGitDeps, 'dockerWorkspaces'> = {}
): Promise<RunTip | null> {
  const git = deps.git ?? runGit;
  const fetched = await fetchHead(review.repoRoot, review.branch, { git, ...(deps.net ? { net: deps.net } : {}) });
  if (fetched === 'failed') return null;
  if (fetched === 'fetched') {
    const sha = await resolveHead(git, review.repoRoot, { from: 'origin', branch: review.branch });
    return sha ? { sha, remote: 'origin' } : null;
  }
  if (sourceOf(review).kind === 'work') return null;
  const sha = line(
    (await tryGit(git, review.repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${review.branch}^{commit}`,
    ])) ?? ''
  );
  return SHA.test(sha) ? { sha, remote: '.' } : null;
}

/**
 * Makes the run's worktree at `tip` and decides what the session does there: the review half only for a spec review
 * (nothing edits a spec under review), and for a branch with no origin that is checked out in some worktree (git
 * refuses to update a branch checked out elsewhere, so every fix push would fail and the run would never settle).
 */
export async function prepareRun(
  review: Review,
  runId: string,
  tip: RunTip,
  deps: SwarmGitDeps
): Promise<{ ok: true; plan: RunPlan } | { ok: false; reason: string }> {
  const git = deps.git ?? runGit;
  if (!SHA.test(tip.sha)) return { ok: false, reason: 'The branch tip is not a commit id' };
  if (!(await validRef(git, review.repoRoot, review.base)))
    return { ok: false, reason: `The base branch ${review.base} is not a valid branch name` };
  const base = await forkPoint(git, review.repoRoot, review.base, tip.sha);
  if (!base) return { ok: false, reason: `The branch has no fork point from ${review.base}` };
  const repo = await resolveCaseRepository(review.repoRoot, {
    dockerWorkspaces: deps.dockerWorkspaces,
    ...(deps.worktreeGit ? { git: deps.worktreeGit } : {}),
  });
  if (!repo.ok) return { ok: false, reason: repo.message };
  const made = await createDetachedWorktree(
    repo.repo,
    { name: runWorktreeName(runId), commit: tip.sha },
    {
      dockerWorkspaces: deps.dockerWorkspaces,
      agentSkillDirs: deps.agentSkillDirs ?? [],
      excludeAlways: true,
      ...(deps.worktreeGit ? { git: deps.worktreeGit } : {}),
    }
  );
  if (!made.ok) return { ok: false, reason: made.message };
  const spec = (await specFilesAt(git, review.repoRoot, base, tip.sha)).length > 0;
  const checkedOut = tip.remote === '.' && (await branchCheckedOut(git, review.repoRoot, review.branch));
  return {
    ok: true,
    plan: { workingDir: made.worktree.path, base, reviewOnly: spec ? 'spec' : checkedOut ? 'checked-out' : null },
  };
}

/** Removes the run's worktree. Never forced: one git refuses (changes left in it) stays, and the reason is returned. */
export async function removeRunWorktree(
  review: Review,
  runId: string,
  deps: SwarmGitDeps & { isInUse: (path: string) => boolean }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const repo = await resolveCaseRepository(review.repoRoot, {
    dockerWorkspaces: deps.dockerWorkspaces,
    ...(deps.worktreeGit ? { git: deps.worktreeGit } : {}),
  });
  if (!repo.ok) return { ok: false, reason: repo.message };
  const removed = await removeCaseWorktree(
    repo.repo,
    { name: runWorktreeName(runId), isInUse: deps.isInUse },
    { dockerWorkspaces: deps.dockerWorkspaces, ...(deps.worktreeGit ? { git: deps.worktreeGit } : {}) }
  );
  if (removed.ok || removed.code === 'NOT_FOUND') return { ok: true };
  return { ok: false, reason: removed.message };
}

/**
 * `isSpecReview()` on the commits themselves: the paths changed from the fork point to the tip, with "linked" read as
 * a changed path that some changed spec file names in its text. The spec files when it is a spec review, else none.
 */
async function specFilesAt(git: GitRunner, repoRoot: string, base: string, tip: string): Promise<string[]> {
  const out = await tryGit(git, repoRoot, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    '-z',
    base,
    tip,
    '--',
  ]);
  if (out === null) return [];
  const changed = out.split('\0').filter((p) => p && isSafeRepoRelativePath(p));
  const specs = changed.filter((p) => /^intent\/[^/]+\.md$/.test(p));
  if (!specs.length) return [];
  const texts: string[] = [];
  for (const path of specs) {
    const text = await readBlob(git, repoRoot, tip, path);
    if (text !== null) texts.push(text);
  }
  const linked = changed.filter((p) => texts.some((t) => t.includes(p)));
  return isSpecReview(changed, linked) ? specs : [];
}

async function readBlob(git: GitRunner, repoRoot: string, commit: string, path: string): Promise<string | null> {
  const blob = `${commit}:${path}`;
  const bytes = Number(line((await tryGit(git, repoRoot, ['cat-file', '-s', blob])) ?? ''));
  if (!Number.isInteger(bytes) || bytes > MAX_REVIEW_DOC_BYTES) return null;
  return tryGit(git, repoRoot, ['cat-file', 'blob', blob]);
}

/**
 * The spec files a merged review changed, when it was a spec review. Its changes are read from where its head left
 * the base line the merge was made on (the merge commit's first parent) to that head, which is what was reviewed.
 * Only a merge commit whose second parent is that head counts: a review Approve found already merged made no commit,
 * and its `mergedSha` says nothing about what the review changed.
 */
async function mergedSpecFiles(git: GitRunner, review: Review): Promise<string[]> {
  const merged = review.decision?.mergedSha;
  if (!merged || !SHA.test(merged)) return [];
  const parent = async (n: number) =>
    line((await tryGit(git, review.repoRoot, ['rev-parse', '--verify', '--quiet', `${merged}^${n}`])) ?? '');
  if ((await parent(2)) !== review.headSha) return [];
  const onto = await parent(1);
  if (!SHA.test(onto)) return [];
  const from = line((await tryGit(git, review.repoRoot, ['merge-base', onto, review.headSha])) ?? '');
  if (!SHA.test(from) || from === review.headSha) return [];
  return specFilesAt(git, review.repoRoot, from, review.headSha);
}

/** The approved spec a run's R-3 step checks the work against, read at the commit that merged it. */
export type RunSpec = { path: string; mergedSha: string; text: string };
/**
 * Whether a run must give an R-3 result (I9), and the spec R-3 reads. `required` is I4's predicate: a work review that
 * is not itself a spec review, attributed to a merged spec review. `spec` is null when R-3 must run but cannot be
 * given its spec, and `missing` says why; that run's R-3 result is then `unavailable`.
 */
export type R3Plan =
  | { required: false }
  | { required: true; spec: RunSpec }
  | { required: true; spec: null; missing: string };

export type AttributionLookup = {
  /** The `createdFrom` of a canvas work item, or undefined when it has none or cannot be read. */
  createdFrom(work: WorkRef): number | undefined;
  reviews(): Review[];
};

/**
 * Reads the R-3 plan of a run of `review` at `tip`. Only reviews in the same repository are read as the parent, so git
 * runs in no repository the caller has not already cleared for this review.
 */
export async function readR3Plan(
  review: Review,
  tip: string,
  lookup: AttributionLookup,
  deps: { git?: GitRunner } = {}
): Promise<R3Plan> {
  const git = deps.git ?? runGit;
  const source = sourceOf(review);
  if (source.kind !== 'work') return { required: false };
  const createdFrom = lookup.createdFrom(source.work);
  if (!createdFrom) return { required: false };
  const parents = [];
  for (const r of lookup.reviews()) {
    const s = sourceOf(r);
    if (r.repoRoot !== review.repoRoot || s.kind !== 'work' || s.work.workspaceId !== source.work.workspaceId) continue;
    if (s.work.number !== createdFrom || !r.decision?.mergedSha) continue;
    parents.push({ review: r, files: await mergedSpecFiles(git, r) });
  }
  const parent = attributedSpec(
    review,
    { createdFrom },
    parents.map((p) => ({ review: p.review, spec: p.files.length > 0 }))
  );
  if (!parent) return { required: false };
  const base = SHA.test(tip) ? await forkPoint(git, review.repoRoot, review.base, tip) : null;
  if (base && (await specFilesAt(git, review.repoRoot, base, tip)).length) return { required: false };
  const files = parents.find((p) => p.review.id === parent.id)!.files;
  const mergedSha = parent.decision!.mergedSha!;
  if (files.length !== 1)
    return {
      required: true,
      spec: null,
      missing: `The spec review "${parent.title}" changed ${files.length} spec files, so R-3 cannot tell which one this work answers to`,
    };
  const path = files[0]!;
  const text = await readBlob(git, review.repoRoot, mergedSha, path);
  if (text === null)
    return { required: true, spec: null, missing: `The spec ${path} could not be read at ${mergedSha.slice(0, 12)}` };
  return { required: true, spec: { path, mergedSha, text } };
}

/** Writes a run's copy of its spec into `dir` (outside every worktree, so the worktree stays removable). */
export async function stageRunSpec(dir: string, runId: string, spec: RunSpec): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${runWorktreeName(runId)}.md`);
  await writeFile(file, spec.text, { mode: 0o600 });
  return file;
}

export const removeRunSpec = (dir: string, runId: string): Promise<void> =>
  rm(join(dir, `${runWorktreeName(runId)}.md`), { force: true });

async function branchCheckedOut(git: GitRunner, repoRoot: string, branch: string): Promise<boolean> {
  const out = await tryGit(git, repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  // Unreadable: assume it is, so the run stays review only rather than pushing into a refusal.
  if (out === null) return true;
  return out.split('\0').includes(`branch refs/heads/${branch}`);
}

/** How long one review's tip read may take, every git process in it together. */
export const WATCH_READ_TIMEOUT_MS = 10_000;
/** New commits listed per moved tip. Past this the list is unreadable, which counts as a change (I8). */
export const MAX_WATCH_COMMITS = 100;

/** A runner whose every call gets what is left of the read's deadline as its timeout. */
const untilDeadline =
  (net: GitRunner, deadline: number): GitRunner =>
  (cwd, args) => {
    const left = deadline - Date.now();
    if (left <= 0)
      return Promise.reject(
        Object.assign(new Error('The tip read ran out of time'), { killed: true, code: 'ETIMEDOUT' })
      );
    return net(cwd, args, { timeoutMs: left });
  };

const hasOrigin = async (git: GitRunner, repoRoot: string): Promise<boolean> =>
  (await tryGit(git, repoRoot, ['remote', 'get-url', 'origin'])) !== null;

/**
 * How the tip watcher reads a review's branch: `git ls-remote origin` when the repository has an origin that has the
 * branch, else, for a session review only, the local branch (a work review lives on origin only). It never fetches to
 * read a tip. Listing the commits of a move reads them locally, and fetches the one branch first only when the new tip
 * is not here yet. Any failure or timeout reads as null.
 */
export function watchTipReader(net: GitRunner = runFetch): TipReader {
  return {
    async tip(review, deadline) {
      const git = untilDeadline(net, deadline);
      if (!(await validRef(git, review.repoRoot, review.branch))) return null;
      const ref = `refs/heads/${review.branch}`;
      if (await hasOrigin(git, review.repoRoot)) {
        const out = await tryGit(git, review.repoRoot, ['ls-remote', 'origin', ref]);
        if (out === null) return null;
        const found = out
          .split('\n')
          .map((l) => l.split('\t'))
          .find(([sha, name]) => name === ref && SHA.test(sha ?? ''));
        if (found) return found[0]!;
      }
      if (sourceOf(review).kind === 'work') return null;
      const sha = line(
        (await tryGit(git, review.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ?? ''
      );
      return SHA.test(sha) ? sha : null;
    },

    async commits(review, from, to, deadline) {
      if (!SHA.test(from) || !SHA.test(to)) return null;
      const git = untilDeadline(net, deadline);
      const present = async () => (await tryGit(git, review.repoRoot, ['cat-file', '-e', `${to}^{commit}`])) !== null;
      if (!(await present())) {
        if (!(await validRef(git, review.repoRoot, review.branch)) || !(await hasOrigin(git, review.repoRoot)))
          return null;
        const branch = review.branch;
        await tryGit(git, review.repoRoot, [
          'fetch',
          '--quiet',
          '--no-tags',
          'origin',
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]);
        if (!(await present())) return null;
      }
      const out = await tryGit(git, review.repoRoot, [
        'log',
        '-z',
        '--no-show-signature',
        `--max-count=${MAX_WATCH_COMMITS + 1}`,
        '--format=%B',
        `${from}..${to}`,
        '--',
      ]);
      if (out === null) return null;
      const messages = out.endsWith('\0') ? out.slice(0, -1).split('\0') : out ? out.split('\0') : [];
      return messages.length > MAX_WATCH_COMMITS ? null : messages.map((message) => ({ message }));
    },
  };
}
