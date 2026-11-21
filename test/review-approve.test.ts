/**
 * @fileoverview Approve on the Reviews page: the merge that touches no working tree, and the deploy it asks for.
 * The merges run against real temporary repositories. The supervisor is always a fake.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import type { DeployOverviewConfigured } from '../src/deploy-control.js';
import { fetchHead, resolveHead, reviewChanges } from '../src/reviews/review-git.js';
import { mergeReviewedBranch } from '../src/reviews/review-merge.js';
import { runGit } from '../src/git-workspace-status.js';
import { settledDeploy, type Decision } from '../src/reviews/review-model.js';
import { readReview, writeReview } from '../src/reviews/review-store.js';
import { registerReviewPageRoutes, type ReviewRouteOptions } from '../src/web/routes/review-routes.js';
import { changeWork, readWork, workPath } from '../src/canvas/work-store.js';
import {
  applyRelease,
  closeLinkedWork,
  commentWork,
  createWork,
  CreateWorkSchema,
  emptyWorkFile,
  findWork,
  releaseFor,
  reportWork,
  ReportWorkSchema,
  type WorkFile,
  updateWork,
  UpdateWorkSchema,
} from '../src/canvas/work.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const gitIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository on `feat/x` with one commit over `main`. With `remote`, `main` and the branch are on a bare origin. */
function makeRepo({ remote = false } = {}): { dir: string; git: (...args: string[]) => string; origin?: string } {
  const dir = temp('review-merge-');
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'c.txt'), 'keep\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(join(dir, 'b.txt'), 'new\n');
  git('add', '.');
  git('commit', '-q', '-m', 'work');
  if (!remote) return { dir, git };
  const origin = temp('review-origin-');
  gitIn(origin)('init', '-q', '--bare', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main', 'feat/x');
  return { dir, git, origin };
}
const input = (repo: { dir: string; git: (...args: string[]) => string }, title = 'Work') => ({
  repoRoot: repo.dir,
  base: 'main',
  head: { from: 'local-first' as const, branch: 'feat/x' },
  headSha: repo.git('rev-parse', 'feat/x'),
  title,
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the merge Approve makes', () => {
  it('goes to origin and leaves a dirty checkout of the base branch exactly as it was', async () => {
    const repo = makeRepo({ remote: true });
    const wanted = input(repo);
    // The base branch is checked out here, with a change nobody has committed.
    repo.git('checkout', '-q', 'main');
    writeFileSync(join(repo.dir, 'c.txt'), 'keep\nmine, uncommitted\n');
    const mainBefore = repo.git('rev-parse', 'main');
    const statusBefore = repo.git('status', '--porcelain');

    const result = await mergeReviewedBranch(wanted);
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ pushed: true, localMoved: false, already: false });

    const origin = gitIn(repo.origin!);
    expect(origin('rev-parse', 'main')).toBe(result.mergedSha);
    expect(origin('show', 'main:a.txt')).toBe('one\nTWO\nthree');
    expect(origin('log', '-1', '--format=%s', 'main')).toBe('Merge feat/x: Work');
    expect(origin('rev-list', '--parents', '-1', 'main').split(' ')).toEqual([
      result.mergedSha,
      mainBefore,
      wanted.headSha,
    ]);
    // The checkout: same commit, same files, same uncommitted change, nothing staged.
    expect(repo.git('rev-parse', 'main')).toBe(mainBefore);
    expect(repo.git('status', '--porcelain')).toBe(statusBefore);
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(readFileSync(join(repo.dir, 'c.txt'), 'utf8')).toBe('keep\nmine, uncommitted\n');
    expect(repo.git('rev-parse', 'origin/main')).toBe(result.mergedSha);
  });

  it('moves a local base branch that no folder has checked out', async () => {
    const repo = makeRepo({ remote: true });
    const result = await mergeReviewedBranch(input(repo));
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ pushed: true, localMoved: true });
    expect(repo.git('rev-parse', 'main')).toBe(result.mergedSha);
    // The session's own checkout of the branch is untouched too.
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x');
  });

  it('without a remote merges into the local branch, and refuses while a folder has that branch checked out', async () => {
    const repo = makeRepo();
    const wanted = input(repo);
    repo.git('checkout', '-q', 'main');
    const refused = await mergeReviewedBranch(wanted);
    expect(refused).toMatchObject({ ok: false, code: 'CHECKED_OUT' });
    expect(repo.git('rev-parse', 'main')).not.toBe(wanted.headSha);

    repo.git('checkout', '-q', 'feat/x');
    const result = await mergeReviewedBranch(wanted);
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ pushed: false, localMoved: true });
    expect(repo.git('show', 'main:b.txt')).toBe('new');
    // A second approval of the same work finds it merged and makes no commit.
    expect(await mergeReviewedBranch(wanted)).toMatchObject({ ok: true, already: true, mergedSha: result.mergedSha });
  });

  it('refuses a branch that moved since it was read, a conflict, and a base that origin moved past', async () => {
    const repo = makeRepo({ remote: true });
    const wanted = input(repo);
    writeFileSync(join(repo.dir, 'b.txt'), 'newer\n');
    repo.git('commit', '-q', '-am', 'more');
    expect(await mergeReviewedBranch(wanted)).toMatchObject({ ok: false, code: 'MOVED' });

    // Someone else changes the same line on origin's main.
    const other = temp('review-other-');
    gitIn(other)('clone', '-q', repo.origin!, '.');
    const theirs = gitIn(other);
    theirs('config', 'user.name', 'o');
    theirs('config', 'user.email', 'o@example.invalid');
    theirs('config', 'commit.gpgsign', 'false');
    writeFileSync(join(other, 'a.txt'), 'one\ntheirs\nthree\n');
    theirs('commit', '-q', '-am', 'theirs');
    theirs('push', '-q', 'origin', 'main');
    const conflict = await mergeReviewedBranch(input(repo));
    expect(conflict).toMatchObject({ ok: false, code: 'CONFLICT' });
    // Nothing was pushed, and nothing local moved.
    expect(gitIn(repo.origin!)('rev-parse', 'main')).toBe(theirs('rev-parse', 'HEAD'));
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});

describe('a head read from origin only', () => {
  /** A clone that has never seen `feat/pr`: the pull request's branch exists only on origin. */
  function prOnOrigin() {
    const upstream = makeRepo({ remote: true });
    const pusher = gitIn(upstream.dir);
    pusher('checkout', '-q', '-b', 'feat/pr', 'main');
    writeFileSync(join(upstream.dir, 'p.txt'), 'pr\n');
    pusher('add', 'p.txt');
    pusher('commit', '-q', '-m', 'pr work');
    pusher('push', '-q', 'origin', 'feat/pr');
    const dir = temp('review-clone-');
    execFileSync('git', ['clone', '-q', upstream.origin!, dir], { stdio: 'ignore' });
    const git = gitIn(dir);
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('update-ref', '-d', 'refs/remotes/origin/feat/pr');
    return { dir, git, tip: pusher('rev-parse', 'feat/pr'), pusher, upstream };
  }
  const origin = (branch: string) => ({ from: 'origin' as const, branch });

  it('fetches the branch, then the Changes tab and Approve read the same commit', async () => {
    const clone = prOnOrigin();
    expect(await resolveHead(runGit, clone.dir, origin('feat/pr'))).toBeNull();
    expect(await fetchHead(clone.dir, 'feat/pr')).toBe('fetched');
    expect(await fetchHead(clone.dir, 'feat/none')).toBe('absent');
    const changes = await reviewChanges(clone.dir, 'main', origin('feat/pr'));
    expect(changes).toMatchObject({ gone: false, headSha: clone.tip });
    expect(changes.files.map((f) => f.path)).toEqual(['p.txt']);
    const merged = await mergeReviewedBranch({
      repoRoot: clone.dir,
      base: 'main',
      head: origin('feat/pr'),
      headSha: clone.tip,
      title: 'PR',
    });
    if (!merged.ok) throw new Error(merged.message);
    expect(gitIn(clone.upstream.origin!)('show', 'main:p.txt')).toBe('pr');
  });

  it('is never shadowed by a stale local branch of the same name', async () => {
    const clone = prOnOrigin();
    // A local feat/pr from an older look at the work: one commit behind what origin has now.
    clone.git('branch', 'feat/pr', 'main');
    expect(await fetchHead(clone.dir, 'feat/pr')).toBe('fetched');
    const stale = clone.git('rev-parse', 'refs/heads/feat/pr');
    expect(stale).not.toBe(clone.tip);
    expect((await reviewChanges(clone.dir, 'main', origin('feat/pr'))).headSha).toBe(clone.tip);
    // The same lookup through a session's locator reads the local branch first: that is what origin-only prevents.
    expect((await reviewChanges(clone.dir, 'main', { from: 'local-first', branch: 'feat/pr' })).headSha).toBe(stale);
    const merged = await mergeReviewedBranch({
      repoRoot: clone.dir,
      base: 'main',
      head: origin('feat/pr'),
      headSha: clone.tip,
      title: 'PR',
    });
    expect(merged).toMatchObject({ ok: true });
  });

  it('reads a branch deleted on origin as absent, and a push past the shown commit as MOVED', async () => {
    const clone = prOnOrigin();
    expect(await fetchHead(clone.dir, 'feat/pr')).toBe('fetched');
    writeFileSync(join(clone.upstream.dir, 'p.txt'), 'pr, again\n');
    clone.pusher('commit', '-q', '-am', 'more');
    clone.pusher('push', '-q', 'origin', 'feat/pr');
    expect(await fetchHead(clone.dir, 'feat/pr')).toBe('fetched');
    const moved = await mergeReviewedBranch({
      repoRoot: clone.dir,
      base: 'main',
      head: origin('feat/pr'),
      headSha: clone.tip,
      title: 'PR',
    });
    expect(moved).toMatchObject({ ok: false, code: 'MOVED' });
    clone.pusher('push', '-q', 'origin', ':feat/pr');
    expect(await fetchHead(clone.dir, 'feat/pr')).toBe('absent');
  });
});

describe('how a deploy ended', () => {
  const deploying: Decision = { kind: 'deploying', at: 1000, mergedSha: 'a'.repeat(40), deployRequestId: 'r1' };
  const run = (outcome: string, failedStep: string | null = null, finishedAt: string | null = 't') => ({
    sha: 'a'.repeat(40),
    action: 'deploy',
    outcome,
    failedStep,
    finishedAt,
  });
  it('reads the supervisor’s record, then the live commit, and gives up only when neither knows it', () => {
    const base = { live: { sha: 'b'.repeat(40) }, busy: false };
    expect(settledDeploy(deploying, { ...base, recent: [run('success')] }, 2000, false)).toMatchObject({
      kind: 'deployed',
    });
    expect(settledDeploy(deploying, { ...base, recent: [run('failed', 'test')] }, 2000, false)).toMatchObject({
      kind: 'deploy-failed',
      error: 'The deploy failed at test',
    });
    expect(settledDeploy(deploying, { ...base, recent: [run('running', null, null)] }, 2000, false)).toBeNull();
    expect(
      settledDeploy(deploying, { live: { sha: 'a'.repeat(40) }, busy: false, recent: [] }, 2000, true)
    ).toMatchObject({
      kind: 'deployed',
    });
    expect(settledDeploy(deploying, { ...base, recent: [] }, 2000, false)).toBeNull();
    expect(settledDeploy(deploying, { ...base, busy: true, recent: [] }, 1000 + 46 * 60_000, false)).toBeNull();
    expect(settledDeploy(deploying, { ...base, recent: [] }, 1000 + 46 * 60_000, false)).toMatchObject({
      kind: 'deploy-failed',
    });
    expect(
      settledDeploy({ kind: 'merged', at: 1, mergedSha: 'a'.repeat(40) }, { ...base, recent: [] }, 2, false)
    ).toBeNull();
    // A stacked review is left `merged` by Approve and is deployed once the live release contains its merge.
    expect(
      settledDeploy({ kind: 'merged', at: 1, mergedSha: 'a'.repeat(40) }, { ...base, recent: [] }, 2, true)
    ).toEqual({ kind: 'deployed', at: 2, mergedSha: 'a'.repeat(40) });
  });
  it('reads a failed deploy as deployed once a later deploy ships the merge, and only then', () => {
    const failed: Decision = { ...deploying, kind: 'deploy-failed', error: 'The deploy failed at health' };
    const base = { live: { sha: 'b'.repeat(40) }, busy: false, recent: [run('failed', 'health')] };
    const shipped = settledDeploy(failed, base, 3000, true);
    expect(shipped).toEqual({ kind: 'deployed', at: 3000, mergedSha: 'a'.repeat(40), deployRequestId: 'r1' });
    expect(settledDeploy(failed, base, 3000, false)).toBeNull();
    expect(settledDeploy(deploying, base, 3000, true)).toMatchObject({ kind: 'deployed' });
  });
});

describe('approve routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let harness: RouteTestHarness;
  const AGENT = { 'x-codeman-parent-session': 'test-session-1' };

  const start = async (options: ReviewRouteOptions = {}) => {
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, { dockerWorkspaces: async () => [], deploy: noSupervisor, ...options })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo.dir;
    const made = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'Done' },
    });
    return made.json().data.id as string;
  };
  const noSupervisor = {
    cli: () => null,
    readOverview: async (): Promise<DeployOverviewConfigured> => {
      throw new Error('no supervisor in this test');
    },
    requestDeploy: async (): Promise<{ requestId: string }> => {
      throw new Error('no supervisor in this test');
    },
  };
  const approve = (id: string, headSha: string, headers: Record<string, string> = {}) =>
    harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/approve`, headers, payload: { headSha } });

  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(async () => {
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  it('merges once, for a person, at the commit they were shown', async () => {
    const id = await start();
    const head = repo.git('rev-parse', 'feat/x');
    expect((await approve(id, head, AGENT)).statusCode).toBe(403);
    expect((await approve(id, 'f'.repeat(40))).json()).toMatchObject({ error: expect.stringContaining('MOVED') });
    expect(repo.git('rev-parse', 'main')).not.toBe(head);

    const read = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data;
    expect(read.approve).toEqual({ deploys: false, shipsWithBase: false });
    const done = await approve(id, head);
    expect(done.statusCode).toBe(200);
    const merged = done.json().data;
    expect(merged.review).toMatchObject({ state: 'merged', decision: { kind: 'merged' } });
    expect(merged.merge).toEqual({ pushed: false, localMoved: true, already: false });
    expect(repo.git('rev-parse', 'main')).toBe(merged.review.decision.mergedSha);

    expect((await approve(id, head)).statusCode).toBe(409);
    const note = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/notes`,
      payload: { at: { kind: 'general' }, text: 'late' },
    });
    expect(note.statusCode).toBe(409);
    const queue = (await harness.app.inject({ url: '/api/reviews' })).json().data;
    expect(queue.waiting).toHaveLength(0);
    expect(queue.decided).toHaveLength(1);
  });

  describe('Approve of a session review closes the work its session left waiting', () => {
    const ctx = { author: { kind: 'human' as const, userId: 'admin' }, now: 1000 };
    const agent = (sessionId: string): WorkCtx => ({ author: { kind: 'agent', sessionId }, now: 2000 });
    type WorkCtx = { author: { kind: 'human'; userId: string } | { kind: 'agent'; sessionId: string }; now: number };
    /** Items each session filed itself in three statuses that link the review's session, and one of another session. */
    const fileItems = () => {
      const workspace = workspaceForCase('review-approve-i8').id;
      const make = (status: string, sessions: string[]) => {
        const made = changeWork(workspace, (f) =>
          createWork(
            f,
            CreateWorkSchema.parse({
              title: `${status} ${sessions[0]}`,
              status,
              sessions,
              ...(status === 'in-progress' ? { assignee: { kind: 'session', sessionId: sessions[0] } } : {}),
            }),
            agent(sessions[0]!)
          )
        );
        if (!made.ok) throw new Error(made.message);
        return made.item.number;
      };
      return {
        workspace,
        inProgress: make('in-progress', ['test-session-1']),
        humanRequired: make('human-required', ['test-session-1']),
        ready: make('ready-for-work', ['test-session-1']),
        otherSession: make('in-progress', ['test-session-9']),
      };
    };
    const statusOf = (workspace: string, number: number) => {
      const read = readWork(workspace);
      if (!read.ok) throw new Error(read.reason);
      return findWork(read.file, number)!;
    };
    afterEach(() => rmSync(dataPath('canvas'), { recursive: true, force: true }));

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it("moves only the session's own In progress item to Done, and tells canvas pages", async () => {
      const items = fileItems();
      const announceWork = vi.fn();
      const id = await start({ announceWork });
      const done = await approve(id, repo.git('rev-parse', 'feat/x'));
      expect(done.statusCode).toBe(200);
      const mergedSha = done.json().data.review.decision.mergedSha as string;

      const closed = statusOf(items.workspace, items.inProgress);
      expect(closed.status).toBe('done');
      expect(closed.history[0]!.text).toBe(`Done: review ${id} merged ${mergedSha.slice(0, 7)}`);
      expect(closed.history.map((e) => e.text)).toContain('Moved from In progress to Done');
      expect(statusOf(items.workspace, items.humanRequired).status).toBe('human-required');
      expect(statusOf(items.workspace, items.ready).status).toBe('ready-for-work');
      expect(statusOf(items.workspace, items.otherSession).status).toBe('in-progress');
      expect(announceWork).toHaveBeenCalledWith(items.workspace);
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('closes nothing when the merge fails', async () => {
      const items = fileItems();
      const id = await start();
      const refused = await approve(id, 'f'.repeat(40));
      expect(refused.statusCode).toBe(409);
      expect(statusOf(items.workspace, items.inProgress).status).toBe('in-progress');
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('closeLinkedWork changes nothing the second time, nor on an item in another status', () => {
      let file = emptyWorkFile();
      const add = (status: string) => {
        const made = createWork(
          file,
          CreateWorkSchema.parse({
            title: status,
            status,
            sessions: ['s'],
            assignee: { kind: 'session', sessionId: 's' },
          }),
          agent('s')
        );
        if (!made.ok) throw new Error(made.message);
        file = made.file;
        return made.item.number;
      };
      const open = add('in-progress');
      const asked = add('human-required');

      const first = closeLinkedWork(file, open, 's', 'r1', 'a'.repeat(40), ctx);
      if (!first.ok) throw new Error(first.message);
      expect(first.item.status).toBe('done');
      const second = closeLinkedWork(first.file, open, 's', 'r1', 'a'.repeat(40), ctx);
      if (!second.ok) throw new Error(second.message);
      expect(second.file).toBe(first.file);
      expect(second.item.history).toEqual(first.item.history);

      const other = closeLinkedWork(file, asked, 's', 'r1', 'a'.repeat(40), ctx);
      expect(other.ok && other.file).toBe(file);
      const unlinked = closeLinkedWork(file, open, 'not-linked', 'r1', 'a'.repeat(40), ctx);
      expect(unlinked.ok && unlinked.file).toBe(file);
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('answers which items it closed, and the ones it could not write, while the merge stands', async () => {
      const items = fileItems();
      const id = await start();
      chmodSync(dirname(workPath(items.workspace)), 0o500);
      let done;
      try {
        done = await approve(id, repo.git('rev-parse', 'feat/x'));
      } finally {
        chmodSync(dirname(workPath(items.workspace)), 0o700);
      }
      expect(done.statusCode).toBe(200);
      expect(done.json().data.review.decision.kind).toBe('merged');
      const linked = done.json().data.linkedWork;
      expect(linked.authorSession).toBe('test-session-1');
      expect(linked.closed).toEqual([]);
      expect(linked.failed.map((f: { key: string }) => f.key)).toEqual([`W-${items.inProgress}`]);
      expect(statusOf(items.workspace, items.inProgress).status).toBe('in-progress');
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('lists the keys it moved to Done in the response', async () => {
      const items = fileItems();
      const id = await start();
      const done = await approve(id, repo.git('rev-parse', 'feat/x'));
      expect(done.json().data.linkedWork).toEqual({
        authorSession: 'test-session-1',
        closed: [`W-${items.inProgress}`],
        failed: [],
      });
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('closeLinkedWork closes what the session left waiting, and nothing anyone touched since', () => {
      let file: WorkFile = emptyWorkFile();
      const apply = (r: ReturnType<typeof createWork>) => {
        if (!r.ok) throw new Error(r.message);
        file = r.file;
        return r.item.number;
      };
      const add = (status: string, sessions: string[], assignee?: string, pr = false, by: WorkCtx = ctx) =>
        apply(
          createWork(
            file,
            CreateWorkSchema.parse({
              title: `${status} ${sessions.join(' ')}`,
              status,
              sessions,
              ...(assignee ? { assignee: { kind: 'session', sessionId: assignee } } : {}),
              ...(pr ? { pr: { url: 'https://github.com/o/r/pull/1', branch: 'feat/x' } } : {}),
            }),
            by
          )
        );
      const ask = (number: number, by: string) =>
        apply(
          reportWork(
            file,
            number,
            ReportWorkSchema.parse({ outcome: 'ask', note: 'Done', question: 'PR is ready for review.' }),
            agent(by)
          )
        );
      const release = (number: number, sessionId: string) => {
        const owner = { kind: 'session' as const, sessionId, state: 'gone' as const };
        const item = findWork(file, number)!;
        const decided = releaseFor(item, file, owner);
        if (!decided) throw new Error('not released');
        apply(applyRelease(file, number, decided, owner, item.revision, agent(sessionId)));
      };

      const closes = {
        inProgress: add('in-progress', ['s'], 's', false, agent('s')),
        asked: add('in-progress', ['s'], 's'),
        released: add('in-progress', ['s'], 's'),
        releasedWithPr: add('in-progress', ['s'], 's', true),
      };
      ask(closes.asked, 's');
      release(closes.released, 's');
      release(closes.releasedWithPr, 's');
      const stays = {
        pickedUpByOther: add('in-progress', ['s', 't'], 't'),
        heldByThePerson: add('in-progress', ['s']),
        askedByOther: add('in-progress', ['s', 't'], 't'),
        answered: add('in-progress', ['s'], 's'),
        releasedByOther: add('in-progress', ['s', 't'], 't'),
        releasedByPrefixedId: add('in-progress', ['s', 'sx'], 'sx'),
        touchedAfterRelease: add('in-progress', ['s'], 's'),
        filedFollowUp: add('backlog', ['s']),
        plainHumanRequired: add('human-required', ['s']),
        assignedByThePerson: add('in-progress', ['s'], 's'),
        askedThenTakenByThePerson: add('in-progress', ['s'], 's'),
        askedThenMovedByOther: add('in-progress', ['s', 't'], 's'),
        askedThenParked: add('in-progress', ['s'], 's'),
        commentedAfterAsk: add('in-progress', ['s'], 's'),
        heldByOtherSWroteLast: add('in-progress', ['s', 't'], 't'),
        askedThenUnlinkedItself: add('in-progress', ['s'], 's'),
      };
      const update = (number: number, patch: Record<string, unknown>, by: WorkCtx) =>
        apply(updateWork(file, number, UpdateWorkSchema.parse(patch), by));
      for (const n of [
        stays.askedThenTakenByThePerson,
        stays.askedThenMovedByOther,
        stays.askedThenParked,
        stays.commentedAfterAsk,
      ])
        ask(n, 's');
      update(stays.askedThenTakenByThePerson, { assignee: { kind: 'person' } }, ctx);
      update(stays.askedThenMovedByOther, { status: 'in-progress' }, agent('t'));
      update(stays.askedThenMovedByOther, { status: 'human-required' }, agent('t'));
      update(stays.askedThenParked, { status: 'backlog' }, ctx);
      update(stays.askedThenParked, { status: 'human-required' }, ctx);
      apply(commentWork(file, stays.commentedAfterAsk, 'Looking', ctx));
      apply(commentWork(file, stays.heldByOtherSWroteLast, 'Notes for t', agent('s')));
      ask(stays.askedThenUnlinkedItself, 's');
      update(stays.askedThenUnlinkedItself, { unlinkSessions: ['s'] }, agent('s'));
      expect(findWork(file, stays.heldByOtherSWroteLast)!.history[0]!.author).toEqual({
        kind: 'agent',
        sessionId: 's',
      });
      expect(findWork(file, stays.askedThenUnlinkedItself)!.needs?.sessionId).toBe('s');
      for (const n of [stays.askedThenTakenByThePerson, stays.askedThenMovedByOther, stays.askedThenParked])
        expect([findWork(file, n)!.status, findWork(file, n)!.needs?.sessionId]).toEqual(['human-required', 's']);
      ask(stays.askedByOther, 't');
      ask(stays.answered, 's');
      apply(updateWork(file, stays.answered, UpdateWorkSchema.parse({ needs: null }), ctx));
      release(stays.releasedByOther, 't');
      release(stays.releasedByPrefixedId, 'sx');
      release(stays.touchedAfterRelease, 's');
      apply(commentWork(file, stays.touchedAfterRelease, 'Still needed?', ctx));
      expect(findWork(file, closes.releasedWithPr)!.status).toBe('human-required');
      expect(findWork(file, closes.releasedWithPr)!.needs?.sessionId).toBeUndefined();
      expect(findWork(file, stays.heldByThePerson)!.assignee).toEqual({ kind: 'person' });

      const before = Object.fromEntries(Object.entries(stays).map(([k, n]) => [k, findWork(file, n)!.status]));
      const close = (n: number) => {
        const r = closeLinkedWork(file, n, 's', 'r1', 'c'.repeat(40), ctx);
        if (!r.ok) throw new Error(r.message);
        file = r.file;
        return r.item.status;
      };
      expect(Object.fromEntries(Object.entries(closes).map(([k, n]) => [k, close(n)]))).toEqual(
        Object.fromEntries(Object.keys(closes).map((k) => [k, 'done']))
      );
      expect(Object.fromEntries(Object.entries(stays).map(([k, n]) => [k, close(n)]))).toEqual(before);
      expect(Object.values(before)).not.toContain('done');
      expect(
        findWork(file, closes.asked)!
          .history.slice(0, 2)
          .map((e) => e.text)
      ).toEqual(['Done: review r1 merged ccccccc', 'Cleared its question']);
      const again = closeLinkedWork(file, closes.asked, 's', 'r1', 'c'.repeat(40), ctx);
      expect(again.ok && again.file).toBe(file);
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('Approve closes an item its session asked about and one released when it ended', async () => {
      const workspace = workspaceForCase('review-approve-i8').id;
      const agentCtx = { author: { kind: 'agent' as const, sessionId: 'test-session-1' }, now: 1500 };
      const make = (title: string) => {
        const made = changeWork(workspace, (f) =>
          createWork(
            f,
            CreateWorkSchema.parse({
              title,
              status: 'in-progress',
              sessions: ['test-session-1'],
              assignee: { kind: 'session', sessionId: 'test-session-1' },
            }),
            ctx
          )
        );
        if (!made.ok) throw new Error(made.message);
        return made.item.number;
      };
      const asked = make('asked');
      const released = make('released');
      const reported = changeWork(workspace, (f) =>
        reportWork(f, asked, ReportWorkSchema.parse({ outcome: 'ask', note: 'Done', question: 'Review it?' }), agentCtx)
      );
      if (!reported.ok) throw new Error(reported.message);
      const owner = { kind: 'session' as const, sessionId: 'test-session-1', state: 'gone' as const };
      const releasedNow = changeWork(workspace, (f) => {
        const item = findWork(f, released)!;
        return applyRelease(f, released, releaseFor(item, f, owner)!, owner, item.revision, agentCtx);
      });
      if (!releasedNow.ok) throw new Error(releasedNow.message);

      const id = await start();
      const done = await approve(id, repo.git('rev-parse', 'feat/x'));
      expect(done.statusCode).toBe(200);
      expect(done.json().data.linkedWork.closed.sort()).toEqual([`W-${asked}`, `W-${released}`].sort());
      expect(statusOf(workspace, asked).status).toBe('done');
      expect(statusOf(workspace, released).status).toBe('done');
    });

    // Invariant I8: SessionReviewApproveClosesWaitingWork
    it('closeLinkedWork records the question and requested changes it clears', () => {
      const made = createWork(
        emptyWorkFile(),
        CreateWorkSchema.parse({
          title: 'open',
          status: 'in-progress',
          sessions: ['s'],
          assignee: { kind: 'session', sessionId: 's' },
        }),
        agent('s')
      );
      if (!made.ok) throw new Error(made.message);
      const item = findWork(made.file, made.item.number)!;
      item.needs = { question: 'Ship it?', at: 1 };
      const closed = closeLinkedWork(made.file, made.item.number, 's', 'r1', 'b'.repeat(40), ctx);
      if (!closed.ok) throw new Error(closed.message);
      expect(closed.item.needs).toBeUndefined();
      expect(closed.item.history.slice(0, 2).map((e) => e.text)).toEqual([
        'Done: review r1 merged bbbbbbb',
        'Cleared its question',
      ]);
    });
  });

  describe('close', () => {
    const close = (id: string, headers: Record<string, string> = {}) =>
      harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/close`, headers, payload: {} });

    it('ends a review without merging, for a person only, and only once', async () => {
      const id = await start();
      const mainBefore = repo.git('rev-parse', 'main');
      expect((await close(id, AGENT)).statusCode).toBe(403);

      const done = await close(id);
      expect(done.statusCode).toBe(200);
      expect(done.json().data.review).toMatchObject({ state: 'closed', decision: { kind: 'closed' } });
      expect(done.json().data.review.decision.mergedSha).toBeUndefined();
      // Nothing merged, and the branch is still there.
      expect(repo.git('rev-parse', 'main')).toBe(mainBefore);
      expect(repo.git('rev-parse', 'feat/x')).toMatch(/^[0-9a-f]{40}$/);

      expect((await close(id)).json()).toMatchObject({ error: expect.stringContaining('DECIDED') });
      expect((await approve(id, repo.git('rev-parse', 'feat/x'))).statusCode).toBe(409);
      const note = await harness.app.inject({
        method: 'POST',
        url: `/api/reviews/${id}/notes`,
        payload: { at: { kind: 'general' }, text: 'late' },
      });
      expect(note.statusCode).toBe(409);
      const queue = (await harness.app.inject({ url: '/api/reviews' })).json().data;
      expect(queue.waiting).toHaveLength(0);
      expect(queue.decided.map((r: { id: string; state: string }) => [r.id, r.state])).toEqual([[id, 'closed']]);
    });

    it('leaves a merged review alone', async () => {
      const id = await start();
      expect((await approve(id, repo.git('rev-parse', 'feat/x'))).statusCode).toBe(200);
      expect((await close(id)).statusCode).toBe(409);
      const read = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
      expect(read.state).toBe('merged');
    });

    it('opens a new review when the same session submits again', async () => {
      const id = await start();
      await close(id);
      const again = await harness.app.inject({
        method: 'POST',
        url: '/api/reviews',
        headers: AGENT,
        payload: { title: 'Work', walkthrough: 'Again' },
      });
      // 201: a new review, not a revision of the closed one.
      expect(again.statusCode).toBe(201);
      expect(again.json().data.id).not.toBe(id);
      expect(again.json().data.state).toBe('ready');
    });
  });

  describe('Approve closes the other reviews of its branch', () => {
    const AGENT2 = { 'x-codeman-parent-session': 'test-session-2' };
    /**
     * A second session on the same checkout under another owner, so a second open review of `feat/x` can exist beside
     * the first: a session of the same owner would update the first review instead.
     */
    const secondSession = () => {
      const first = harness.ctx.sessions.get('test-session-1')!;
      const twin = Object.assign(Object.create(Object.getPrototypeOf(first)), first, {
        id: 'test-session-2',
        owner: 'other',
      });
      harness.ctx.sessions.set('test-session-2', twin);
    };
    const commit = (name: string) => {
      writeFileSync(join(repo.dir, name), `${name}\n`);
      repo.git('add', name);
      repo.git('commit', '-q', '-m', name);
      return repo.git('rev-parse', 'HEAD');
    };
    const submit = async (headers: Record<string, string>) => {
      const made = await harness.app.inject({
        method: 'POST',
        url: '/api/reviews',
        headers,
        payload: { title: 'Work', walkthrough: 'Done' },
      });
      expect(made.statusCode).toBe(201);
      return made.json().data.id as string;
    };
    const read = async (id: string) => (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;

    it('closes an older review whose commits the merge holds, and says which review closed it', async () => {
      const older = await start();
      secondSession();
      const tip = commit('more.txt');
      const newer = await submit(AGENT2);

      const done = await approve(newer, tip);
      expect(done.statusCode).toBe(200);
      expect(done.json().data.closedOthers).toEqual([older]);
      expect(await read(older)).toMatchObject({ state: 'closed', decision: { kind: 'closed', closedBy: newer } });
      expect(await read(newer)).toMatchObject({ state: 'merged' });
    });

    it('leaves open a review with commits the merge does not hold', async () => {
      const first = repo.git('rev-parse', 'feat/x');
      const older = await start();
      secondSession();
      commit('more.txt');
      const newer = await submit(AGENT2);
      // The branch goes back, and the older review is approved: the newer one's commit is not in that merge.
      repo.git('reset', '-q', '--hard', first);

      const done = await approve(older, first);
      expect(done.statusCode).toBe(200);
      expect(done.json().data.closedOthers).toEqual([]);
      expect(await read(newer)).toMatchObject({ state: 'ready' });
    });

    it('reopens a closed review, for a person only, unless another review of the branch is open', async () => {
      const id = await start();
      const reopen = (rid: string, headers: Record<string, string> = {}) =>
        harness.app.inject({ method: 'POST', url: `/api/reviews/${rid}/reopen`, headers, payload: {} });
      expect((await reopen(id)).json()).toMatchObject({ error: expect.stringContaining('NOT_CLOSED') });

      await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/close`, payload: {} });
      expect((await reopen(id, AGENT)).statusCode).toBe(403);

      // While a newer review of the branch is open, reopening would make two.
      const twin = await submit(AGENT);
      const refused = await reopen(id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain(twin);
      await harness.app.inject({ method: 'POST', url: `/api/reviews/${twin}/close`, payload: {} });

      const back = await reopen(id);
      expect(back.statusCode).toBe(200);
      expect(back.json().data.review.state).toBe('ready');
      expect(back.json().data.review.decision).toBeUndefined();
      // Open again, so Approve merges it.
      expect((await approve(id, repo.git('rev-parse', 'feat/x'))).statusCode).toBe(200);
    });
  });

  it('for the repository Codeman is built from, asks for a deploy of the merge and follows it to the end', async () => {
    const live = repo.git('rev-parse', 'main');
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: live, since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const requestDeploy = vi.fn(async () => ({ requestId: 'req-1' }));
    const id = await start({
      deploy: { cli: () => '/fake/supervisor', readOverview: async () => overview, requestDeploy },
    });
    expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.approve).toEqual({
      deploys: true,
      shipsWithBase: false,
    });

    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data;
    const mergedSha = done.review.decision.mergedSha as string;
    expect(done.review).toMatchObject({ state: 'deploying', decision: { deployRequestId: 'req-1' } });
    expect(requestDeploy).toHaveBeenCalledExactlyOnceWith('/fake/supervisor', mergedSha);
    expect((await harness.app.inject({ url: '/api/reviews' })).json().data.waiting).toHaveLength(1);

    overview.recent = [
      {
        id: 'd1',
        action: 'deploy',
        sha: mergedSha,
        outcome: 'failed',
        failedStep: 'test',
        startedAt: 't',
        finishedAt: 't',
      },
    ];
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ['Date'] });
    try {
      const failed = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
      expect(failed).toMatchObject({
        state: 'deploy-failed',
        decision: { error: 'The deploy failed at test', mergedSha },
      });
      // Approve is not offered twice; the deploy is asked for again without a second merge.
      expect((await approve(id, repo.git('rev-parse', 'feat/x'))).statusCode).toBe(409);
      const again = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/deploy`, payload: {} });
      expect(again.json().data.review).toMatchObject({ state: 'deploying', decision: { mergedSha } });
      expect(requestDeploy).toHaveBeenCalledTimes(2);
      expect(repo.git('rev-parse', 'main')).toBe(mergedSha);

      overview.recent = [
        {
          id: 'd2',
          action: 'deploy',
          sha: mergedSha,
          outcome: 'success',
          failedStep: null,
          startedAt: 'u',
          finishedAt: 'u',
        },
      ];
      vi.setSystemTime(Date.now() + 10_000);
      const deployed = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
      expect(deployed.state).toBe('deployed');
      const retry = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/deploy`, payload: {} });
      expect(retry.statusCode).toBe(409);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges a stacked review into its base without a deploy, and settles it once the base ships', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const requestDeploy = vi.fn(async () => ({ requestId: 'req-1' }));
    repo.git('branch', 'stack', 'main');
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => '/fake/supervisor', readOverview: async () => overview, requestDeploy },
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo.dir;
    const made = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'Done', base: 'stack' },
    });
    const id = made.json().data.id as string;
    expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.approve).toEqual({
      deploys: false,
      shipsWithBase: true,
    });

    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data;
    const mergedSha = done.review.decision.mergedSha as string;
    expect(done.review).toMatchObject({ state: 'merged', decision: { kind: 'merged', mergedSha } });
    expect(repo.git('rev-parse', 'stack')).toBe(mergedSha);
    expect(repo.git('rev-parse', 'main')).toBe(overview.live!.sha);
    expect(requestDeploy).not.toHaveBeenCalled();

    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ['Date'] });
    try {
      expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review.state).toBe('merged');
      repo.git('checkout', '-q', 'main');
      repo.git('merge', '-q', '--no-ff', '-m', 'land the stack', 'stack');
      overview.live = { sha: repo.git('rev-parse', 'main'), since: 'u' };
      vi.setSystemTime(Date.now() + 5_000);
      const review = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
      expect(review).toMatchObject({ state: 'deployed', decision: { mergedSha } });
      expect(requestDeploy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a stacked review whose folder was removed after the merge', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const requestDeploy = vi.fn(async () => ({ requestId: 'req-1' }));
    repo.git('branch', 'stack', 'main');
    repo.git('checkout', '-q', 'main');
    const tree = join(temp('review-tree-'), 'w');
    repo.git('worktree', 'add', '-q', tree, 'feat/x');
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => '/fake/supervisor', readOverview: async () => overview, requestDeploy },
      })
    );
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.workingDir = tree;
    const submit = (base: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/reviews',
        headers: AGENT,
        payload: { title: 'Work', walkthrough: 'Done', base },
      });
    const id = (await submit('stack')).json().data.id as string;
    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data;
    const mergedSha = done.review.decision.mergedSha as string;
    expect(done.review.state).toBe('merged');
    repo.git('worktree', 'remove', '--force', tree);

    // Another review names the main checkout, as reviews of the same repository do.
    repo.git('checkout', '-q', '-b', 'feat/z', 'main');
    repo.git('commit', '-q', '--allow-empty', '-m', 'other work');
    session.workingDir = repo.dir;
    expect((await submit('main')).statusCode).toBe(201);
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'land the stack', 'stack');
    overview.live = { sha: repo.git('rev-parse', 'main'), since: 'u' };

    vi.useFakeTimers({ now: Date.now() + 40_000, toFake: ['Date'] });
    try {
      const review = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
      expect(review).toMatchObject({ state: 'deployed', decision: { mergedSha } });
      expect(requestDeploy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to ask again for a deploy of a stacked merge whose deploy failed', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const requestDeploy = vi.fn(async () => ({ requestId: 'req-1' }));
    repo.git('branch', 'stack', 'main');
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => '/fake/supervisor', readOverview: async () => overview, requestDeploy },
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo.dir;
    const made = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'Done', base: 'stack' },
    });
    const id = made.json().data.id as string;
    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data;
    const mergedSha = done.review.decision.mergedSha as string;
    // A stacked review left `deploy-failed` by a build from before stacked reviews were recognised.
    const stored = readReview(id);
    if (!stored.ok) throw new Error('review not stored');
    writeReview({ ...stored.review, decision: { kind: 'deploy-failed', at: 1, mergedSha, error: 'refused' } });

    const again = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/deploy`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/^STACKED:/);
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it('refuses to ask again for a deploy of a stacked merge whose review folder was removed', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const requestDeploy = vi.fn(async () => ({ requestId: 'req-1' }));
    repo.git('branch', 'stack', 'main');
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => '/fake/supervisor', readOverview: async () => overview, requestDeploy },
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo.dir;
    const made = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'Done', base: 'stack' },
    });
    const id = made.json().data.id as string;
    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data;
    const mergedSha = done.review.decision.mergedSha as string;
    // Left `deploy-failed` by an older build, in a worktree that was removed after the merge.
    const stored = readReview(id);
    if (!stored.ok) throw new Error('review not stored');
    writeReview({
      ...stored.review,
      repoRoot: `${repo.dir}-removed`,
      decision: { kind: 'deploy-failed', at: 1, mergedSha, error: 'refused' },
    });

    const view = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data;
    expect(view.approve).toMatchObject({ deploys: false, shipsWithBase: true });
    const again = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/deploy`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/^STACKED:/);
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it('does not read a merged review into main on every settle, since it is never stacked', async () => {
    const overview: DeployOverviewConfigured = { configured: true, live: null, releases: [], recent: [], busy: false };
    const readOverview = vi.fn(async () => overview);
    const requestDeploy = vi.fn(async () => ({ requestId: 'req-1' }));
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => '/fake/supervisor', readOverview, requestDeploy },
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo.dir;
    const made = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'Done', base: 'main' },
    });
    const id = made.json().data.id as string;
    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data;
    expect(done.review.decision.kind).toBe('merged');
    expect(requestDeploy).not.toHaveBeenCalled();
    readOverview.mockClear();

    vi.useFakeTimers({ now: Date.now() + 50_000, toFake: ['Date'] });
    try {
      expect((await harness.app.inject({ url: '/api/reviews' })).statusCode).toBe(200);
      expect(readOverview).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the queue when a later deploy ships a merge whose own deploy failed', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const id = await start({
      deploy: {
        cli: () => '/fake/supervisor',
        readOverview: async () => overview,
        requestDeploy: async () => ({ requestId: 'req-1' }),
      },
    });
    const mergedSha = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data.review.decision
      .mergedSha as string;
    overview.recent = [
      {
        id: 'd1',
        action: 'deploy',
        sha: mergedSha,
        outcome: 'failed',
        failedStep: 'health',
        startedAt: 't',
        finishedAt: 't',
      },
    ];
    // The settle throttle is module-wide, and the test before this one left it ahead of the real clock.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] });
    try {
      expect((await harness.app.inject({ url: '/api/reviews' })).json().data.waiting).toHaveLength(1);

      repo.git('checkout', '-q', 'main');
      repo.git('commit', '-q', '--allow-empty', '-m', 'later work');
      overview.live = { sha: repo.git('rev-parse', 'main'), since: 'u' };
      vi.setSystemTime(Date.now() + 10_000);
      const queue = (await harness.app.inject({ url: '/api/reviews' })).json().data;
      expect(queue.waiting).toHaveLength(0);
      expect(queue.decided).toMatchObject([{ id, state: 'deployed' }]);
      const review = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
      expect(review.decision).not.toHaveProperty('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a failed deploy whose review folder was removed after the merge', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const id = await start({
      deploy: {
        cli: () => '/fake/supervisor',
        readOverview: async () => overview,
        requestDeploy: async () => ({ requestId: 'req-1' }),
      },
    });
    const mergedSha = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data.review.decision
      .mergedSha as string;
    overview.recent = [
      {
        id: 'd1',
        action: 'deploy',
        sha: mergedSha,
        outcome: 'failed',
        failedStep: 'health',
        startedAt: 't',
        finishedAt: 't',
      },
    ];
    const worktree = `${repo.dir}-removed`;
    repo.git('worktree', 'add', '-q', '--detach', worktree, 'feat/x');
    const path = dataPath('reviews', `${id}.json`);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const otherId = 'b'.repeat(16);
    const { decision: _none, ...undecided } = file.review;
    writeFileSync(
      dataPath('reviews', `${otherId}.json`),
      JSON.stringify({ ...file, review: { ...undecided, id: otherId } })
    );
    file.review.repoRoot = worktree;
    writeFileSync(path, JSON.stringify(file));
    repo.git('worktree', 'remove', worktree);

    repo.git('checkout', '-q', 'main');
    repo.git('commit', '-q', '--allow-empty', '-m', 'later work');
    overview.live = { sha: repo.git('rev-parse', 'main'), since: 'u' };
    vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] });
    try {
      const queue = (await harness.app.inject({ url: '/api/reviews' })).json().data;
      expect(queue.decided).toMatchObject([{ id, state: 'deployed' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the merge even when the deploy cannot be requested', async () => {
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: repo.git('rev-parse', 'main'), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    const id = await start({
      deploy: {
        cli: () => '/fake/supervisor',
        readOverview: async () => overview,
        requestDeploy: async () => {
          throw new Error('The deploy supervisor could not be started');
        },
      },
    });
    const done = (await approve(id, repo.git('rev-parse', 'feat/x'))).json().data.review;
    expect(done).toMatchObject({
      state: 'deploy-failed',
      decision: { error: 'The deploy supervisor could not be started', mergedSha: repo.git('rev-parse', 'main') },
    });
  });
});
