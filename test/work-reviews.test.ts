/**
 * @fileoverview Reviews of the pull requests canvas work items carry: the pure rules (`work-review-model.ts`, the
 * source codec in `review-model.ts`, the item changes in `work.ts`) and `sync` against real temporary repositories
 * with a bare `origin` (`work-reviews.ts`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveWork,
  CreateWorkSchema,
  createWork,
  emptyWorkFile,
  escalateWork,
  reportWork,
  ReportWorkSchema,
  requestChangesOnWork,
  updateWork,
  UpdateWorkSchema,
  workBrief,
  type WorkFile,
} from '../src/canvas/work.js';
import { changeWork, readWork } from '../src/canvas/work-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { deployRole } from '../src/deploy-role.js';
import {
  queueOf,
  ReviewFileSchema,
  reviewState,
  sourceOf,
  stampSent,
  storedSource,
  type Review,
} from '../src/reviews/review-model.js';
import { readReview } from '../src/reviews/review-store.js';
import { escalationHeld } from '../src/reviews/review-work.js';
import {
  adoptSessionReviews,
  syncedReview,
  walkthroughOf,
  wanted,
  workReviewId,
} from '../src/reviews/work-review-model.js';
import { createWorkReviews } from '../src/reviews/work-reviews.js';

const person = { kind: 'human' as const, userId: 'admin' };
const ctx = { author: person, now: 1000 };
const URL1 = 'https://github.com/example/repo/pull/58';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const work = { workspaceId: '0b6b4c1e-5d0b-4d5c-9d47-1c0f0e6c2a10', number: 38 };

function itemFile(extra: Record<string, unknown> = {}): WorkFile {
  const made = createWork(
    emptyWorkFile(),
    CreateWorkSchema.parse({ title: 'Outline sections', status: 'in-progress', ...extra }),
    ctx
  );
  if (!made.ok) throw new Error(made.message);
  return made.file;
}
const facts = (headSha = SHA1) => ({
  repoRoot: '/repo',
  project: 'repo',
  branch: 'build/w-38',
  base: 'main',
  headSha,
  title: 'Outline sections',
  walkthrough: 'What changed',
  owner: null,
});

describe('work review rules', () => {
  it('keeps the source in sessionId, and decodes it back; a session id reads as a session', () => {
    const stored = storedSource({ kind: 'work', work });
    expect(stored).toEqual({ sessionId: `work:${work.workspaceId}:38`, sessionName: 'W-38' });
    expect(sourceOf(stored)).toEqual({ kind: 'work', work });
    const session = { sessionId: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d', sessionName: 'w4' };
    expect(sourceOf(session)).toEqual({ kind: 'session', ...session });
    for (const sessionId of ['work:', 'work:x:0', 'work:x:1:2', 'work:a b:1', 'xwork:x:1'])
      expect(sourceOf({ sessionId, sessionName: '' }).kind, sessionId).toBe('session');
  });

  it('gives one review per item and pull request, and a new one for a new pull request', () => {
    const id = workReviewId(work, URL1);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(workReviewId(work, URL1)).toBe(id);
    expect(workReviewId(work, `${URL1}0`)).not.toBe(id);
    expect(workReviewId({ ...work, number: 39 }, URL1)).not.toBe(id);
  });

  it('is wanted only while the item is open and carries the same pull request on a branch', () => {
    const review = { id: workReviewId(work, URL1) };
    const item = (patch: Record<string, unknown>) => ({ ...itemFile().items[0]!, number: 38, ...patch });
    expect(wanted(item({ pr: { url: URL1, branch: 'b' } }), review, work)).toBe(true);
    expect(wanted(item({ pr: { url: URL1 } }), review, work)).toBe(false);
    expect(wanted(item({ pr: { url: `${URL1}0`, branch: 'b' } }), review, work)).toBe(false);
    expect(wanted(item({ pr: { url: URL1, branch: 'b' }, status: 'done' }), review, work)).toBe(false);
    expect(wanted(item({ pr: { url: URL1, branch: 'b' }, status: 'not-doing' }), review, work)).toBe(false);
    expect(wanted(undefined, review, work)).toBe(false);
  });

  it('syncs a review: new, unchanged, words only, then a push the person has not seen', () => {
    const id = workReviewId(work, URL1);
    const first = syncedReview(undefined, facts(), work, id, 1000);
    expect(first).toMatchObject({ id, revision: 1, sessionName: 'W-38', headSha: SHA1, createdAt: 1000 });
    expect(sourceOf(first)).toEqual({ kind: 'work', work });
    expect(syncedReview(first, facts(), work, id, 2000)).toBe(first);

    const sent = stampSent(first, [], 1500);
    const reworded = syncedReview(sent, { ...facts(), walkthrough: 'Said more' }, work, id, 2000);
    expect(reworded).toMatchObject({ walkthrough: 'Said more', revision: 1, updatedAt: 1000 });
    expect(reviewState(reworded)).toBe('changes-requested');

    const pushed = syncedReview(reworded, facts(SHA2), work, id, 3000);
    expect(pushed).toMatchObject({ headSha: SHA2, revision: 2, updatedAt: 3000 });
    expect(reviewState(pushed)).toBe('updated');

    const merged: Review = { ...pushed, decision: { kind: 'merged', at: 4000, mergedSha: SHA2 } };
    expect(syncedReview(merged, facts(SHA1), work, id, 5000)).toBe(merged);
  });

  it('a takeover keeps the state the session review read: Request changes sent and not answered', () => {
    const id = workReviewId(work, URL1);
    const made = syncedReview(undefined, facts(), work, id, 5000);
    const session: Review = {
      ...made,
      id: 'aaaaaaaaaaaaaaaa',
      ...storedSource({ kind: 'session', sessionId: 's-1', sessionName: 'w1' }),
      walkthrough: 'Mine',
      requestedAt: 3000,
      createdAt: 1000,
      updatedAt: 2000,
    };
    expect(reviewState(session)).toBe('changes-requested');
    const taken = adoptSessionReviews(made, [session], []);
    expect(reviewState(taken)).toBe('changes-requested');
    expect(taken).toMatchObject({ createdAt: 5000, authored: { sessionId: 's-1', walkthrough: 'Mine', at: 2000 } });
    expect(ReviewFileSchema.safeParse({ version: 1, review: taken }).success).toBe(true);
  });

  it('writes a work review the previous release reads: no key its strict schema does not know', () => {
    const review = syncedReview(undefined, facts(), work, workReviewId(work, URL1), 1000);
    const disk = JSON.parse(JSON.stringify({ version: 1, review }));
    expect(ReviewFileSchema.safeParse(disk).success).toBe(true);
  });

  it('composes the walkthrough from the newest word of the agent, the description and the link', () => {
    const base = { ...itemFile({ description: 'Each section gets a heading.' }).items[0]!, pr: { url: URL1 } };
    expect(walkthroughOf(base)).toBe(
      `## W-1: Outline sections\n\nEach section gets a heading.\n\nPull request: ${URL1}`
    );
    const reported = { ...base, outcome: { kind: 'done' as const, text: 'Verified in the browser.', at: 5 } };
    expect(walkthroughOf(reported)).toMatch(/^## The agent's report\n\nVerified in the browser\./);
    const asked = { ...reported, needs: { question: 'Keep the old order?', at: 6 } };
    expect(walkthroughOf(asked)).toMatch(/^## The agent asked\n\nKeep the old order\?/);
  });

  it('keeps a work review waiting only while its item wants it; a session review always waits', () => {
    const id = workReviewId(work, URL1);
    const review = syncedReview(undefined, facts(), work, id, 1000);
    const fact = { workspaceId: work.workspaceId, key: 'W-38', title: 'T', status: 'in-progress', prUrl: URL1 };
    expect(queueOf([review], 2000).waiting).toEqual([]);
    expect(queueOf([review], 2000, new Map([[id, { ...fact, wanted: false }]])).waiting).toEqual([]);
    const shown = queueOf([review], 2000, new Map([[id, { ...fact, wanted: true }]])).waiting;
    expect(shown).toMatchObject([{ id, work: { key: 'W-38', prUrl: URL1 } }]);
  });
});

describe('work item changes a review makes', () => {
  it('Request changes: notes on the item, question closed, first in Ready for work; the next report clears them', () => {
    let file = itemFile();
    const other = createWork(file, CreateWorkSchema.parse({ title: 'Other', status: 'ready-for-work' }), ctx);
    if (!other.ok) throw new Error(other.message);
    file = other.file;
    const asked = reportWork(file, 1, ReportWorkSchema.parse({ outcome: 'ask', note: 'n', question: 'q?' }), ctx);
    if (!asked.ok) throw new Error(asked.message);
    const sent = requestChangesOnWork(
      asked.file,
      1,
      { text: 'Rename the heading', reviewId: 'r'.repeat(16), at: 7 },
      ctx
    );
    if (!sent.ok) throw new Error(sent.message);
    expect(sent.item).toMatchObject({ status: 'ready-for-work', changes: { text: 'Rename the heading' } });
    expect(sent.item.needs).toBeUndefined();
    expect(sent.file.readyOrder).toEqual([1, 2]);
    expect(Object.keys(workBrief(sent.item, sent.file))[0]).toBe('changesRequested');
    expect(sent.item.history.map((e) => e.text)).toContain('Changes requested in review');
    const reported = reportWork(sent.file, 1, ReportWorkSchema.parse({ outcome: 'continue', note: 'pushed' }), ctx);
    expect(reported.ok && reported.item.changes).toBeUndefined();
    const closed = updateWork(sent.file, 1, UpdateWorkSchema.parse({ status: 'done' }), ctx);
    if (!closed.ok) throw new Error(closed.message);
    expect(requestChangesOnWork(closed.file, 1, { text: 'x', reviewId: 'r', at: 8 }, ctx)).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });

  it('pr-swarm escalation: Human required with the note as its question and a comment; never closed or Backlog', () => {
    const agent = { author: { kind: 'agent' as const, sessionId: 'swarm-session' }, now: 2000 };
    const moved = escalateWork(itemFile(), 1, 'pr-swarm escalated the review', agent);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.item).toMatchObject({
      status: 'human-required',
      needs: { question: 'pr-swarm escalated the review', at: 2000 },
    });
    expect(moved.item.comments.at(-1)).toEqual({
      at: 2000,
      author: agent.author,
      text: 'pr-swarm escalated the review',
    });
    expect(moved.item.sessions).not.toContain('swarm-session');
    expect(moved.item.history.map((e) => e.text)).toContain('Escalated to a person by an automated review');
    const long = escalateWork(moved.file, 1, 'x'.repeat(5000), agent);
    expect(long.ok && long.item.needs!.question.length).toBe(2000);

    const closed = updateWork(itemFile(), 1, UpdateWorkSchema.parse({ status: 'done' }), ctx);
    if (!closed.ok) throw new Error(closed.message);
    expect(escalateWork(closed.file, 1, 'n', agent)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(escalateWork(itemFile({ status: 'backlog' }), 1, 'n', agent)).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });

  it('escalationHeld: only an item the escalation moved holds it, and leaving Human required releases it', () => {
    const agent = { author: { kind: 'agent' as const, sessionId: 'swarm-session' }, now: 2000 };
    const moved = escalateWork(itemFile(), 1, 'note', agent);
    if (!moved.ok) throw new Error(moved.message);
    const w = (item: typeof moved.item) => ({ workspaceId: 'ws', number: 1, item });
    expect(escalationHeld([w(moved.item)], 2000)).toBe(true);
    // An item the escalation refused (Backlog) never held it, so the tick must not read it as answered.
    const backlog = itemFile({ status: 'backlog' }).items[0];
    expect(escalationHeld([w(backlog)], 2000)).toBeNull();
    // An older escalation's line does not count for a newer one.
    expect(escalationHeld([w(moved.item)], 2001)).toBeNull();
    const answered = updateWork(moved.file, 1, UpdateWorkSchema.parse({ needs: null }), {
      ...ctx,
      now: 3000,
    });
    if (!answered.ok) throw new Error(answered.message);
    expect(escalationHeld([w(answered.item), w(backlog)], 2000)).toBe(false);
  });

  it('Approve: the item is done, with the merge in its history; once', () => {
    const done = approveWork(itemFile(), 1, SHA2, ctx);
    if (!done.ok) throw new Error(done.message);
    expect(done.item.status).toBe('done');
    expect(done.item.history[0]!.text).toBe('Approved and merged 2222222 in review');
    const again = approveWork(done.file, 1, SHA2, ctx);
    expect(again.ok && again.file).toBe(done.file);
  });
});

describe('sync against a repository with an origin', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const gitIn =
    (cwd: string) =>
    (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A case folder whose clone has never fetched `build/w-1`; the work exists only on origin. */
  function setup(caseName: string) {
    const author = temp('work-review-author-');
    const a = gitIn(author);
    a('init', '-q', '-b', 'main');
    a('config', 'user.name', 't');
    a('config', 'user.email', 't@example.invalid');
    a('config', 'commit.gpgsign', 'false');
    writeFileSync(join(author, 'a.txt'), 'one\n');
    a('add', '.');
    a('commit', '-q', '-m', 'base');
    const origin = temp('work-review-origin-');
    gitIn(origin)('init', '-q', '--bare', '-b', 'main');
    a('remote', 'add', 'origin', origin);
    a('push', '-q', 'origin', 'main');
    a('checkout', '-q', '-b', 'build/w-1');
    writeFileSync(join(author, 'b.txt'), 'new\n');
    a('add', '.');
    a('commit', '-q', '-m', 'work');
    a('push', '-q', 'origin', 'build/w-1');
    const repo = temp('work-review-case-');
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
    gitIn(repo)('update-ref', '-d', 'refs/remotes/origin/build/w-1');
    const workspace = workspaceForCase(caseName);
    const announced: Review[] = [];
    const reviews = createWorkReviews({
      casePath: async () => repo,
      dockerWorkspaces: async () => [],
      announce: (r) => announced.push(r),
    });
    const ref = { workspaceId: workspace.id, number: 1 };
    const file = (patch: Record<string, unknown>) =>
      changeWork(workspace.id, (f) =>
        f.items.length
          ? updateWork(f, 1, UpdateWorkSchema.parse(patch), ctx)
          : createWork(f, CreateWorkSchema.parse({ title: 'Outline', status: 'in-progress', ...patch }), ctx)
      );
    return { a, repo, reviews, ref, file, announced, tip: () => a('rev-parse', 'HEAD') };
  }

  it('makes the review from origin, keeps it when nothing moved, and takes a later push', async () => {
    const s = setup('wr-case-1');
    s.file({ pr: { url: URL1, branch: 'build/w-1' } });
    const first = await s.reviews.sync(s.ref);
    if (!('review' in first)) throw new Error(JSON.stringify(first));
    expect(first).toMatchObject({ changed: true, review: { headSha: s.tip(), branch: 'build/w-1', base: 'main' } });
    expect(readReview(first.review.id).ok).toBe(true);
    expect(s.announced).toHaveLength(1);
    expect(await s.reviews.sync(s.ref)).toMatchObject({ changed: false });

    writeFileSync(join(s.a('rev-parse', '--show-toplevel'), 'b.txt'), 'newer\n');
    s.a('commit', '-q', '-am', 'more');
    s.a('push', '-q', 'origin', 'build/w-1');
    expect(await s.reviews.sync(s.ref)).toMatchObject({ changed: true, review: { headSha: s.tip(), revision: 2 } });

    const facts = s.reviews.facts([first.review]);
    expect(facts.get(first.review.id)).toMatchObject({ key: 'W-1', prUrl: URL1, wanted: true });
    s.file({ pr: null });
    expect(s.reviews.facts([first.review]).size).toBe(0);
    expect(await s.reviews.sync(s.ref)).toEqual({ unwanted: true });
  });

  it('answers a branch origin lacks, and writes nothing on a colour that may not', async () => {
    const s = setup('wr-case-2');
    s.file({ pr: { url: URL1, branch: 'build/missing' } });
    expect(await s.reviews.sync(s.ref)).toMatchObject({ problem: 'NO_BRANCH' });
    s.file({ pr: { url: URL1, branch: 'build/w-1' } });
    vi.spyOn(deployRole, 'allows').mockReturnValue(false);
    expect(await s.reviews.sync(s.ref)).toMatchObject({ problem: 'NOT_LIVE' });
    expect(readReview(workReviewId(s.ref, URL1))).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses a repository inside a Docker case workspace before any fetch', async () => {
    const s = setup('wr-case-3');
    s.file({ pr: { url: URL1, branch: 'build/w-1' } });
    const net = vi.fn(async () => '');
    const refused = createWorkReviews({
      casePath: async () => s.repo,
      dockerWorkspaces: async () => [s.repo],
      announce: () => undefined,
      net,
    });
    expect(await refused.sync(s.ref)).toMatchObject({ problem: 'REFUSED' });
    expect(net).not.toHaveBeenCalled();
  });

  it('follows item writes, and Approve marks the item done', async () => {
    const s = setup('wr-case-4');
    const stop = s.reviews.follow();
    try {
      s.file({ pr: { url: URL1, branch: 'build/w-1' } });
      await vi.waitFor(() => expect(readReview(workReviewId(s.ref, URL1)).ok).toBe(true), { timeout: 10_000 });
    } finally {
      stop();
    }
    const read = readReview(workReviewId(s.ref, URL1));
    if (!read.ok) throw new Error('no review');
    s.reviews.accepted(read.review, SHA2, person);
    const item = readWork(s.ref.workspaceId);
    expect(item.ok && item.file.items[0]).toMatchObject({ status: 'done' });
  });
});
