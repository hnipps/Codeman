/**
 * @fileoverview Reviews of the pull requests canvas work items carry. The one module that reads both `reviews/` and
 * `canvas/work*`; routes never see a workspace path, a refspec or the stored `work:` form.
 *
 * An item with `pr.branch` that is not closed wants a review. `sync` makes or updates that review from the item and from
 * `origin`, and is safe to run for any item any number of times: the review id is derived from the item and the pull
 * request (`workReviewId`), so two syncs cannot make two reviews. It runs when an item is written (`subscribeWork`),
 * when a work review's page is read, before Approve, and once after boot for items that have no review yet. Never on a
 * timer, and never for the polled queue read.
 *
 * A new work review takes over the owner's undecided session reviews of the same branch (an agent that submitted before
 * it set the item's pull request): the newest gives it its walkthrough, all of them their notes and stills, and every
 * one closes, naming it.
 *
 * Git runs in the repository of the workspace's case, and never for a remote or Docker case or for a repository at or
 * inside a Docker case workspace. The head is read from `origin` only (`headOf`). Only the live deploy colour writes,
 * checked at the moment of each write.
 */
import { basename } from 'node:path';
import { getDataDir } from '../config/instance.js';
import { deployRole } from '../deploy-role.js';
import { readDockerCases } from '../docker-hosts.js';
import { isInsideAny, runGit, type GitRunner } from '../git-workspace-status.js';
import { readRemoteCases } from '../remote-hosts.js';
import { probePathKind } from '../utils/bounded-path-probe.js';
import type { Author } from '../canvas/model.js';
import { approveWork, findWork, requestChangesOnWork, workClosed, workKey, type WorkItem } from '../canvas/work.js';
import { changeWork, readWork, subscribeWork } from '../canvas/work-store.js';
import { readWorkspaces, type Workspace } from '../canvas/workspace-registry.js';
import { defaultBase, fetchHead, line, resolveHead, tryGit, validRef } from './review-git.js';
import {
  closeReview,
  isOpen,
  MAX_OPEN_REVIEWS,
  sourceOf,
  type RepoFacts,
  type Review,
  type Submit,
  type WorkFacts,
  type WorkRef,
} from './review-model.js';
import { changeReview, copyCaptureFiles, listReviews, readReview, writeReview } from './review-store.js';
import {
  adoptSessionReviews,
  authorWorkReview,
  syncedReview,
  walkthroughOf,
  wanted,
  workReviewId,
} from './work-review-model.js';

export type SyncProblem = 'NO_BRANCH' | 'NO_BASE' | 'NO_REPO' | 'REFUSED' | 'FETCH_FAILED' | 'FULL' | 'NOT_LIVE';
export type SyncResult =
  | { review: Review; changed: boolean }
  | { problem: SyncProblem; message: string }
  | { unwanted: true };

/** The agent session submitting a walkthrough, and the owner its workspaces must have. */
export type Submitter = { sessionId: string; sessionName: string; owner: string | null | undefined };
/**
 * Where a submission goes. `none`: no open item claims the branch in this repository, so it makes a session review.
 * `unlinked`: an item claims it but does not link the session. `conflict`: the submission cannot be written now.
 * `written`: the item's work review now carries the walkthrough; `goneSha` is the head it showed before.
 */
export type AuthorResult =
  | { kind: 'none' }
  | { kind: 'unlinked'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'written'; review: Review; goneSha: string | undefined };

export interface WorkReviewDeps {
  /** The case folder of a workspace, as the canvas resolves it for its owner. */
  casePath: (workspace: Workspace) => Promise<string>;
  /** Host paths of Docker case workspaces; rejects when the list cannot be read. */
  dockerWorkspaces: () => Promise<string[]>;
  announce: (review: Review) => void;
  /** Tells canvas pages that a workspace's items changed. */
  announceWork?: (workspaceId: string) => void;
  git?: GitRunner;
  net?: GitRunner;
  now?: () => number;
}

export interface WorkReviews {
  /** Brings one item's review in step with the item and with origin. */
  sync(work: WorkRef, opts?: { fetch?: boolean }): Promise<SyncResult>;
  /** Writes an agent's walkthrough onto the work review of the item it builds, when `facts` is that item's branch. */
  authorFor(caller: Submitter, facts: RepoFacts, input: Submit): Promise<AuthorResult>;
  /** What the tracker says now about each work review in `reviews`, by review id. One read per workspace. */
  facts(reviews: Review[]): Map<string, WorkFacts>;
  /** Puts the reviewer's notes on the item and moves it to the top of Ready for work. */
  sendChanges(
    review: Review,
    text: string,
    author: Author
  ): { ok: true; key: string; position: number } | { ok: false; message: string };
  /** Approve merged the pull request: the item is done. */
  accepted(review: Review, mergedSha: string, author: Author): void;
  /** One pass after boot: syncs every item that wants a review and has none yet. */
  catchUp(): Promise<void>;
  /** Follows item writes until the returned function is called. */
  follow(): () => void;
}

const problem = (code: SyncProblem, message: string): SyncResult => ({ problem: code, message: `${code}: ${message}` });
const workOf = (review: Review): WorkRef | null => {
  const source = sourceOf(review);
  return source.kind === 'work' ? source.work : null;
};

export function createWorkReviews(deps: WorkReviewDeps): WorkReviews {
  const git = deps.git ?? runGit;
  const now = deps.now ?? Date.now;
  /** One fetch per repository and branch at a time; a second sync waits for the first. */
  const fetching = new Map<string, Promise<'fetched' | 'absent' | 'failed'>>();

  const fetchOnce = (repoRoot: string, branch: string) => {
    const key = `${repoRoot}\n${branch}`;
    let running = fetching.get(key);
    if (!running) {
      running = fetchHead(repoRoot, branch, { git, net: deps.net }).finally(() => fetching.delete(key));
      fetching.set(key, running);
    }
    return running;
  };

  const commonDir = async (cwd: string): Promise<string> =>
    line((await tryGit(git, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ?? '');

  /** A session review nothing was decided on: the only kind a work review takes over (a failed deploy is decided). */
  const adoptable = (r: Review): boolean => r.decision === undefined && sourceOf(r).kind === 'session';

  /**
   * Ids of the owner's undecided session reviews of `branch` in the repository at `repoRoot`. A session review records
   * the top level of the folder it was submitted from, often a worktree, so the repository is matched by its common git
   * directory, as `authorFor` matches it, never by the path. Git runs in none at or inside a Docker case workspace.
   */
  const sessionReviewsOf = async (owner: string | null, repoRoot: string, branch: string): Promise<string[]> => {
    const found = listReviews().filter((r) => adoptable(r) && r.owner === owner && r.branch === branch);
    if (!found.length) return [];
    const mine = await commonDir(repoRoot);
    if (!mine) return [];
    let roots: string[];
    try {
      roots = await deps.dockerWorkspaces();
    } catch {
      return [];
    }
    const dirs = new Map<string, string>();
    const ids: string[] = [];
    for (const r of found) {
      if (!dirs.has(r.repoRoot))
        dirs.set(r.repoRoot, (await isInsideAny(r.repoRoot, roots)) ? '' : await commonDir(r.repoRoot));
      if (dirs.get(r.repoRoot) === mine) ids.push(r.id);
    }
    return ids;
  };

  const itemOf = (work: WorkRef): WorkItem | undefined => {
    const read = readWork(work.workspaceId);
    return read.ok ? findWork(read.file, work.number) : undefined;
  };

  /** The repository top level of a workspace's case, or why git may not run there. */
  const repoOf = async (workspace: Workspace): Promise<{ repoRoot: string } | SyncResult> => {
    const owner = workspace.owner;
    const sameCase = (c: { name: string; owner?: string }) => c.name === workspace.caseName && c.owner === owner;
    if ((await readRemoteCases(getDataDir())).some(sameCase))
      return problem('REFUSED', 'a remote case cannot be reviewed here');
    if ((await readDockerCases(getDataDir())).some(sameCase))
      return problem('REFUSED', 'a Docker case cannot be reviewed here');
    const path = await deps.casePath(workspace);
    if ((await probePathKind(path)) !== 'directory')
      return problem('NO_REPO', `the folder of case ${workspace.caseName} cannot be read`);
    const repoRoot = line((await tryGit(git, path, ['rev-parse', '--show-toplevel'])) ?? '');
    if (!repoRoot) return problem('NO_REPO', `case ${workspace.caseName} is not a git repository`);
    let roots: string[];
    try {
      roots = await deps.dockerWorkspaces();
    } catch {
      return problem('REFUSED', 'the Docker case list could not be read, so no repository is inspected');
    }
    if (await isInsideAny(repoRoot, roots))
      return problem('REFUSED', 'a repository inside a Docker case cannot be reviewed here');
    return { repoRoot };
  };

  const accepted: WorkReviews['accepted'] = (review, mergedSha, author) => {
    const work = workOf(review);
    if (!work || !deployRole.allows('persist')) return;
    const changed = changeWork(work.workspaceId, (file) =>
      approveWork(file, work.number, mergedSha, { author, now: now() })
    );
    if (changed.ok) deps.announceWork?.(work.workspaceId);
  };

  const sync: WorkReviews['sync'] = async (work, opts = {}) => {
    const item = itemOf(work);
    if (!item?.pr?.branch) return { unwanted: true };
    const id = workReviewId(work, item.pr.url);
    const stored = readReview(id);
    const existing = stored.ok ? stored.review : undefined;
    if (existing?.decision) {
      // A merge recorded before the item heard of it (a crash in between) marks the item done now.
      if (existing.decision.mergedSha && !workClosed(item.status))
        accepted(existing, existing.decision.mergedSha, { kind: 'human', userId: existing.owner ?? 'admin' });
      return { review: existing, changed: false };
    }
    if (workClosed(item.status)) return { unwanted: true };
    const workspace = readWorkspaces().find((w) => w.id === work.workspaceId);
    if (!workspace) return problem('NO_REPO', 'the workspace no longer exists');
    const repo = await repoOf(workspace);
    if (!('repoRoot' in repo)) return repo;
    const { repoRoot } = repo;
    const branch = item.pr.branch;
    if (opts.fetch !== false) {
      const fetched = await fetchOnce(repoRoot, branch);
      if (fetched === 'absent') return problem('NO_BRANCH', `${branch} is not on origin`);
      if (fetched === 'failed') return problem('FETCH_FAILED', `${branch} could not be fetched from origin`);
    }
    const headSha = await resolveHead(git, repoRoot, { from: 'origin', branch });
    if (!headSha) return problem('NO_BRANCH', `${branch} is not on origin`);
    const base = item.pr.base ?? (await defaultBase(git, repoRoot));
    if (!base || !(await validRef(git, repoRoot, base)) || base === branch)
      return problem('NO_BASE', `no base branch to compare ${branch} with`);
    const owner = workspace.owner ?? null;
    const candidates = existing ? [] : await sessionReviewsOf(owner, repoRoot, branch);

    // No await from here: the item and the review are read again and written in one tick.
    const fresh = itemOf(work);
    if (!fresh || !wanted(fresh, { id }, work) || fresh.pr?.branch !== branch) return { unwanted: true };
    const againRead = readReview(id);
    const open = againRead.ok ? againRead.review : undefined;
    if (!againRead.ok && againRead.reason !== 'missing')
      return problem('REFUSED', 'the review file could not be read; nothing was changed');
    // Session reviews of this branch, submitted before the item had its pull request, are the same work: the new work
    // review takes them over (the newest gives the walkthrough) and every one of them closes, naming the work review.
    const newer = (a: Review, b: Review) => b.updatedAt - a.updatedAt || (a.id > b.id ? -1 : 1);
    const adopted = open
      ? []
      : candidates
          .flatMap((rid) => {
            const read = readReview(rid);
            return read.ok && adoptable(read.review) ? [read.review] : [];
          })
          .sort(newer);
    if (
      !open &&
      !adopted.length &&
      listReviews().filter((r) => isOpen(r) && r.owner === owner).length >= MAX_OPEN_REVIEWS
    )
      return problem('FULL', 'too many reviews are waiting; decide some first');
    const at = now();
    const next = syncedReview(
      open,
      {
        repoRoot,
        project: basename(repoRoot),
        branch,
        base,
        headSha,
        title: fresh.title,
        walkthrough: walkthroughOf(fresh),
        owner,
      },
      work,
      id,
      at
    );
    if (next === open) return { review: next, changed: false };
    if (!deployRole.allows('persist')) return problem('NOT_LIVE', 'only the live colour writes reviews');
    const written = adopted.length ? adoptSessionReviews(next, adopted, copyCaptureFiles(adopted, id)) : next;
    writeReview(written);
    deps.announce(written);
    for (const r of adopted) {
      const closed = changeReview(r.id, (current) => closeReview(current, at, id));
      if (closed.ok) deps.announce(closed.review);
    }
    return { review: written, changed: true };
  };

  const facts: WorkReviews['facts'] = (reviews) => {
    const files = new Map<string, ReturnType<typeof readWork>>();
    const out = new Map<string, WorkFacts>();
    for (const review of reviews) {
      const work = workOf(review);
      if (!work) continue;
      let read = files.get(work.workspaceId);
      if (!read) files.set(work.workspaceId, (read = readWork(work.workspaceId)));
      const item = read.ok ? findWork(read.file, work.number) : undefined;
      if (!item?.pr || workReviewId(work, item.pr.url) !== review.id) continue;
      out.set(review.id, {
        workspaceId: work.workspaceId,
        key: workKey(item.number),
        title: item.title,
        status: item.status,
        prUrl: item.pr.url,
        wanted: wanted(item, review, work),
      });
    }
    return out;
  };

  const sendChanges: WorkReviews['sendChanges'] = (review, text, author) => {
    const work = workOf(review);
    if (!work) return { ok: false, message: 'This review is not of a work item' };
    const changed = changeWork(work.workspaceId, (file) =>
      requestChangesOnWork(file, work.number, { text, reviewId: review.id, at: now() }, { author, now: now() })
    );
    if (!changed.ok) return { ok: false, message: changed.message };
    deps.announceWork?.(work.workspaceId);
    return { ok: true, key: workKey(work.number), position: 1 };
  };

  const catchUp: WorkReviews['catchUp'] = async () => {
    for (const workspace of readWorkspaces()) {
      const read = readWork(workspace.id);
      if (!read.ok) continue;
      for (const item of read.file.items) {
        const work = { workspaceId: workspace.id, number: item.number };
        if (!item.pr?.branch || workClosed(item.status)) continue;
        if (readReview(workReviewId(work, item.pr.url)).ok) continue;
        await sync(work).catch(() => undefined);
      }
    }
  };

  const follow = () =>
    subscribeWork((workspaceId, change) => {
      for (const item of [change.item, ...change.filed])
        if (item.pr) void sync({ workspaceId, number: item.number }).catch(() => undefined);
    });

  const authorFor: WorkReviews['authorFor'] = async (caller, repo, input) => {
    const owner = caller.owner || null;
    const claimed: { work: WorkRef; item: WorkItem; prUrl: string; workspace: Workspace }[] = [];
    for (const workspace of readWorkspaces()) {
      if ((workspace.owner || null) !== owner) continue;
      const read = readWork(workspace.id);
      if (!read.ok) continue;
      for (const item of read.file.items)
        if (item.pr?.branch === repo.branch && !workClosed(item.status))
          claimed.push({
            work: { workspaceId: workspace.id, number: item.number },
            item,
            prUrl: item.pr.url,
            workspace,
          });
    }
    if (!claimed.length) return { kind: 'none' };

    const mine = await commonDir(repo.repoRoot);
    const roots = new Map<string, string | null>();
    const same: ((typeof claimed)[number] & { repoRoot: string })[] = [];
    for (const c of claimed) {
      if (!roots.has(c.workspace.id)) {
        const found = await repoOf(c.workspace);
        roots.set(c.workspace.id, 'repoRoot' in found ? found.repoRoot : null);
      }
      const repoRoot = roots.get(c.workspace.id);
      if (repoRoot && mine && (await commonDir(repoRoot)) === mine) same.push({ ...c, repoRoot });
    }
    if (!same.length) return { kind: 'none' };
    const names = (list: typeof same) => list.map((c) => workKey(c.item.number)).join(', ');
    const linked = same.filter((c) => c.item.sessions.includes(caller.sessionId));
    if (!linked.length)
      return {
        kind: 'unlinked',
        message: `UNLINKED: ${repo.branch} is the pull request of ${names(same)}, which does not link this session; link it with canvas_work update first`,
      };
    if (linked.length > 1)
      return {
        kind: 'conflict',
        message: `AMBIGUOUS: ${repo.branch} is the pull request of ${names(linked)}; unlink this session from all but one`,
      };
    const { work, item, prUrl, repoRoot } = linked[0]!;
    const conflict = (message: string): AuthorResult => ({ kind: 'conflict', message });

    // A walkthrough never describes commits the reviewer cannot see.
    const fetched = await fetchOnce(repoRoot, repo.branch);
    if (fetched === 'absent') return conflict(`UNPUSHED: push the branch, then submit; origin has no ${repo.branch}`);
    if (fetched === 'failed') return conflict(`FETCH_FAILED: ${repo.branch} could not be fetched from origin`);
    const tip = await resolveHead(git, repoRoot, { from: 'origin', branch: repo.branch });
    if (tip !== repo.headSha)
      return conflict(
        `UNPUSHED: push the branch, then submit; origin/${repo.branch} is ${tip?.slice(0, 7) ?? 'missing'}, this session is at ${repo.headSha.slice(0, 7)}`
      );

    const before = readReview(workReviewId(work, prUrl));
    const synced = await sync(work, { fetch: false });
    if ('problem' in synced) return conflict(synced.message);
    if ('unwanted' in synced) return conflict(`GONE: ${workKey(item.number)} no longer asks for a review`);
    const decided = `DECIDED: the review of ${workKey(item.number)} is already decided`;
    if (!isOpen(synced.review)) return conflict(decided);
    if (!deployRole.allows('persist')) return conflict('NOT_LIVE: only the live colour writes reviews');

    // No await from here: the item is read again and the review is changed in one tick.
    const fresh = itemOf(work);
    if (
      !fresh ||
      !wanted(fresh, synced.review, work) ||
      fresh.pr?.branch !== repo.branch ||
      !fresh.sessions.includes(caller.sessionId)
    )
      return conflict(`GONE: ${workKey(item.number)} changed while the walkthrough was submitted; submit again`);
    const changed = changeReview<{ ok: false; message: string }>(synced.review.id, (r) =>
      isOpen(r)
        ? { ok: true, review: authorWorkReview(r, input, caller, repo.headSha, now()) }
        : { ok: false, message: decided }
    );
    if (!changed.ok) return conflict(changed.message);
    return { kind: 'written', review: changed.review, goneSha: before.ok ? before.review.headSha : undefined };
  };

  return { sync, authorFor, facts, sendChanges, accepted, catchUp, follow };
}
