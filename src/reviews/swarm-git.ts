/**
 * @fileoverview What a pr-swarm run on a review does in git: read the branch tip the run reviews, make the run's
 * detached worktree at that tip, and remove it again (`intent/2026-11-20-pr-swarm-reviews.md`).
 *
 * The rules are `review-git.ts`'s: argv only, every ref checked, no git on a remote or Docker case or inside a Docker
 * case workspace (the caller refuses those first, and the worktree functions refuse a Docker workspace again). The
 * worktree is a managed one (`<repo>/.claude/worktrees/swarm-<runId>`), made and removed by the same functions the
 * worktree routes use, so it is never forced away and a name is always recognisable as a run's.
 */
import {
  createDetachedWorktree,
  removeCaseWorktree,
  resolveCaseRepository,
  type WorktreeGitRunner,
} from '../git-worktrees.js';
import { isSafeRepoRelativePath, runGit, type GitRunner } from '../git-workspace-status.js';
import { fetchHead, forkPoint, line, MAX_REVIEW_DOC_BYTES, resolveHead, SHA, tryGit, validRef } from './review-git.js';
import { sourceOf, type Review } from './review-model.js';
import { isSpecReview } from './swarm-model.js';

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
  const spec = await specReviewAt(git, review.repoRoot, base, tip.sha);
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
 * a changed path that some changed spec file names in its text.
 */
async function specReviewAt(git: GitRunner, repoRoot: string, base: string, tip: string): Promise<boolean> {
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
  if (out === null) return false;
  const changed = out.split('\0').filter((p) => p && isSafeRepoRelativePath(p));
  const specs = changed.filter((p) => /^intent\/[^/]+\.md$/.test(p));
  if (!specs.length) return false;
  const texts: string[] = [];
  for (const path of specs) {
    const blob = `${tip}:${path}`;
    const bytes = Number(line((await tryGit(git, repoRoot, ['cat-file', '-s', blob])) ?? ''));
    if (!Number.isInteger(bytes) || bytes > MAX_REVIEW_DOC_BYTES) continue;
    texts.push((await tryGit(git, repoRoot, ['cat-file', 'blob', blob])) ?? '');
  }
  return isSpecReview(
    changed,
    changed.filter((p) => texts.some((t) => t.includes(p)))
  );
}

async function branchCheckedOut(git: GitRunner, repoRoot: string, branch: string): Promise<boolean> {
  const out = await tryGit(git, repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  // Unreadable: assume it is, so the run stays review only rather than pushing into a refusal.
  if (out === null) return true;
  return out.split('\0').includes(`branch refs/heads/${branch}`);
}
