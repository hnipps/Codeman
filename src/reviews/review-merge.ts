/**
 * @fileoverview Approve: merges a reviewed branch into its base. The one part of the Reviews page that writes to a
 * repository.
 *
 * The merge is made of objects and refs only (`git merge-tree --write-tree`, `git commit-tree`, a push or a
 * compare-and-swap `git update-ref`). No command here reads or writes a working tree or an index, so a checkout of the
 * base branch, clean or not, keeps its files exactly as they were.
 *
 * - With an `origin` remote the merge commit is pushed to the base branch there, without force. A local base branch
 *   that no worktree has checked out is then moved forward to it; one that is checked out is left where it was, and
 *   that checkout is simply behind its remote, as it would be after a pull request merged.
 * - Without a remote the local base branch is the only place the merge can go. It is moved only when no worktree has
 *   it checked out: moving a checked-out branch under its index would make the next commit there undo the merge.
 * - The branch must still point at the commit the reviewer was shown. Anything newer is refused, so what was read is
 *   what merges.
 * - A conflict is refused. Nothing resolves one here; the agent merges the base into its branch and submits again.
 *   Merge attributes are read from the base tip (`--attr-source`, git 2.40+), so the `.gitattributes` files on the base
 *   branch decide, for example, that `docs/JOURNAL.md` merges by union.
 * - `--no-verify` on the push: the reviewer's approval is the gate, and a repository's pre-push hook would otherwise
 *   run inside the Codeman server.
 *
 * The caller refuses a remote or Docker session, and a repository at or inside a Docker case workspace, before this
 * runs, and holds one merge per repository at a time.
 */
import { sanitizeGitOutput } from '../git-clone.js';
import { runFetch } from '../git-fetch.js';
import { runGit, type GitRunner } from '../git-workspace-status.js';
import { cleanLine } from './review-model.js';
import { line, NETWORK_TIMEOUT_MS, resolveHead, SHA, tryGit, validRef, type HeadLocator } from './review-git.js';

export type MergeRefusalCode =
  | 'GONE'
  | 'MOVED'
  | 'DIVERGED'
  | 'CONFLICT'
  | 'FETCH_FAILED'
  | 'PUSH_FAILED'
  | 'CHECKED_OUT'
  | 'IDENTITY'
  | 'FAILED';
export type MergeResult =
  | {
      ok: true;
      /** The commit the base branch now ends at. */
      mergedSha: string;
      /** The merge went to the `origin` remote. */
      pushed: boolean;
      /** The local base branch was moved forward. False when a worktree has it checked out, or there is none. */
      localMoved: boolean;
      /** The branch was already part of its base, so no commit was made. */
      already: boolean;
    }
  | { ok: false; code: MergeRefusalCode; message: string };

const refuse = (code: MergeRefusalCode, message: string): MergeResult => ({ ok: false, code, message });
const reason = (err: unknown): string => {
  const stderr = (err as { stderr?: unknown }).stderr;
  const text = sanitizeGitOutput(typeof stderr === 'string' ? stderr : '', 400)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return text ? `: ${text}` : '';
};

const shaOf = async (git: GitRunner, cwd: string, ref: string): Promise<string | null> => {
  const sha = line((await tryGit(git, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ?? '');
  return SHA.test(sha) ? sha : null;
};
const isAncestor = async (git: GitRunner, cwd: string, older: string, newer: string): Promise<boolean> =>
  (await tryGit(git, cwd, ['merge-base', '--is-ancestor', older, newer])) !== null;

/** True when some worktree of this repository has `branch` checked out. */
export async function checkedOutSomewhere(git: GitRunner, cwd: string, branch: string): Promise<boolean> {
  const out = (await tryGit(git, cwd, ['worktree', 'list', '--porcelain'])) ?? '';
  return out.split('\n').some((l) => l === `branch refs/heads/${branch}`);
}

export interface MergeInput {
  repoRoot: string;
  base: string;
  /** Where the reviewed branch is read (`review-git.ts`). */
  head: HeadLocator;
  /** The branch tip the reviewer was shown. */
  headSha: string;
  title: string;
}

export async function mergeReviewedBranch(
  input: MergeInput,
  deps: { git?: GitRunner; net?: GitRunner } = {}
): Promise<MergeResult> {
  const git = deps.git ?? runGit;
  const net = deps.net ?? runFetch;
  const { repoRoot, base } = input;
  const branch = input.head.branch;
  if (!SHA.test(input.headSha) || !(await validRef(git, repoRoot, base)) || !(await validRef(git, repoRoot, branch)))
    return refuse('FAILED', 'FAILED: the review names a branch or commit git does not accept');

  const head = await resolveHead(git, repoRoot, input.head);
  if (!head) return refuse('GONE', `GONE: the branch ${branch} no longer exists`);
  if (head !== input.headSha)
    return refuse('MOVED', `MOVED: ${branch} has changed since you read it; reload the review and read what is new`);

  const hasRemote = (await tryGit(git, repoRoot, ['remote', 'get-url', 'origin'])) !== null;
  if (hasRemote) {
    try {
      await net(
        repoRoot,
        ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`],
        { timeoutMs: NETWORK_TIMEOUT_MS }
      );
    } catch (err) {
      // A base branch that exists only here is merged here; any other failure stops before anything is written.
      if (await shaOf(git, repoRoot, `refs/remotes/origin/${base}`))
        return refuse('FETCH_FAILED', `FETCH_FAILED: ${base} could not be fetched from origin${reason(err)}`);
    }
  }
  const local = await shaOf(git, repoRoot, `refs/heads/${base}`);
  const remote = hasRemote ? await shaOf(git, repoRoot, `refs/remotes/origin/${base}`) : null;
  let tip = local ?? remote;
  if (!tip) return refuse('GONE', `GONE: the base branch ${base} no longer exists`);
  if (local && remote && local !== remote) {
    if (await isAncestor(git, repoRoot, local, remote)) tip = remote;
    else if (await isAncestor(git, repoRoot, remote, local)) tip = local;
    else
      return refuse(
        'DIVERGED',
        `DIVERGED: ${base} here and ${base} on origin have each commits the other lacks; bring them together first`
      );
  }
  const baseCheckedOut = local !== null && (await checkedOutSomewhere(git, repoRoot, base));
  // Pushing goes to the remote the base branch lives on. A base that exists only here is merged here.
  const publish = hasRemote && remote !== null;
  if (!publish && baseCheckedOut)
    return refuse(
      'CHECKED_OUT',
      `CHECKED_OUT: ${base} is checked out in a folder and this repository has no remote copy of it to merge on; check out another branch in that folder, then approve again`
    );

  let merged = tip;
  const already = await isAncestor(git, repoRoot, head, tip);
  if (!already) {
    let tree: string;
    try {
      // Merge attributes come from the base tip: the shared checkout's working tree may be on any branch, and the
      // reviewed branch must not choose how it merges.
      tree = line(
        await git(repoRoot, [`--attr-source=${tip}`, 'merge-tree', '--write-tree', '--no-messages', tip, head])
      );
    } catch (err) {
      return (err as { code?: unknown }).code === 1
        ? refuse(
            'CONFLICT',
            `CONFLICT: ${branch} conflicts with ${base}; ask the agent to merge ${base} into the branch and submit again`
          )
        : refuse('FAILED', `FAILED: git could not work out the merge${reason(err)}`);
    }
    if (!SHA.test(tree)) return refuse('FAILED', 'FAILED: git could not work out the merge');
    const message = `Merge ${branch}: ${cleanLine(input.title, 140)}\n\nApproved on the Codeman Reviews page.`;
    try {
      merged = line(await git(repoRoot, ['commit-tree', tree, '-p', tip, '-p', head, '-m', message]));
    } catch (err) {
      return refuse('IDENTITY', `IDENTITY: git could not write the merge commit${reason(err)}`);
    }
    if (!SHA.test(merged)) return refuse('FAILED', 'FAILED: git could not write the merge commit');
  }

  if (publish && merged !== remote) {
    try {
      await net(repoRoot, ['push', '--quiet', '--no-verify', 'origin', `${merged}:refs/heads/${base}`], {
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
    } catch (err) {
      return refuse(
        'PUSH_FAILED',
        `PUSH_FAILED: the merge could not be pushed to origin; nothing changed${reason(err)}`
      );
    }
  }
  let localMoved = false;
  if (!baseCheckedOut) {
    // Compare-and-swap: a base branch that moved while this ran is left alone. The merge is on the remote by now.
    const args = ['update-ref', '-m', `review: merge ${branch}`, `refs/heads/${base}`, merged];
    if (local === null) localMoved = !publish && (await tryGit(git, repoRoot, [...args, ''])) !== null;
    else if (local === merged) localMoved = false;
    else localMoved = (await tryGit(git, repoRoot, [...args, local])) !== null;
    if (!publish && !localMoved && local !== merged)
      return refuse('FAILED', `FAILED: ${base} changed while the merge was being made; approve again`);
  }
  return { ok: true, mergedSha: merged, pushed: publish, localMoved, already };
}
