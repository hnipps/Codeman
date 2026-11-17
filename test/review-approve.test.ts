/**
 * @fileoverview Approve on the Reviews page: the merge that touches no working tree, and the deploy it asks for.
 * The merges run against real temporary repositories. The supervisor is always a fake.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import type { DeployOverviewConfigured } from '../src/deploy-control.js';
import { fetchHead, resolveHead, reviewChanges } from '../src/reviews/review-git.js';
import { mergeReviewedBranch } from '../src/reviews/review-merge.js';
import { runGit } from '../src/git-workspace-status.js';
import { settledDeploy, type Decision } from '../src/reviews/review-model.js';
import { registerReviewPageRoutes, type ReviewRouteOptions } from '../src/web/routes/review-routes.js';
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
    expect(settledDeploy(deploying, { ...base, recent: [run('success')] }, 2000)).toMatchObject({ kind: 'deployed' });
    expect(settledDeploy(deploying, { ...base, recent: [run('failed', 'test')] }, 2000)).toMatchObject({
      kind: 'deploy-failed',
      error: 'The deploy failed at test',
    });
    expect(settledDeploy(deploying, { ...base, recent: [run('running', null, null)] }, 2000)).toBeNull();
    expect(settledDeploy(deploying, { live: { sha: 'a'.repeat(40) }, busy: false, recent: [] }, 2000)).toMatchObject({
      kind: 'deployed',
    });
    expect(settledDeploy(deploying, { ...base, recent: [] }, 2000)).toBeNull();
    expect(settledDeploy(deploying, { ...base, busy: true, recent: [] }, 1000 + 46 * 60_000)).toBeNull();
    expect(settledDeploy(deploying, { ...base, recent: [] }, 1000 + 46 * 60_000)).toMatchObject({
      kind: 'deploy-failed',
    });
    expect(settledDeploy({ kind: 'merged', at: 1, mergedSha: 'a'.repeat(40) }, { ...base, recent: [] }, 2)).toBeNull();
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
    expect(read.approve).toEqual({ deploys: false });
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
    expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.approve).toEqual({ deploys: true });

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
