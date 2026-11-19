/**
 * @fileoverview The agent's walkthrough on a work review (`authored`, release 1 of
 * `docs/work-review-walkthroughs-spec.md`): the stored shape reads with and without it, a route read returns it, and
 * a sync of the item never touches it. Nothing writes `authored` in this release, so the tests write the file
 * themselves.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { CreateWorkSchema, createWork, updateWork, UpdateWorkSchema } from '../src/canvas/work.js';
import { changeWork } from '../src/canvas/work-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { ReviewFileSchema, stampSent, toView, type Authored, type Review } from '../src/reviews/review-model.js';
import { readReview, writeReview } from '../src/reviews/review-store.js';
import { syncedReview, workReviewId } from '../src/reviews/work-review-model.js';
import { createWorkReviews } from '../src/reviews/work-reviews.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const URL1 = 'https://github.com/example/repo/pull/71';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const work = { workspaceId: '0b6b4c1e-5d0b-4d5c-9d47-1c0f0e6c2a10', number: 71 };
const facts = (headSha = SHA1, walkthrough = 'The item text') => ({
  repoRoot: '/repo',
  project: 'repo',
  branch: 'build/w-71',
  base: 'main',
  headSha,
  title: 'Walkthroughs',
  walkthrough,
  owner: null,
});
const authored = (headSha = SHA1): Authored => ({
  sessionId: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
  sessionName: 'w7-codeman',
  walkthrough: '## What changed\n\nSee [the schema](#code=src/reviews/review-model.ts:10).',
  headSha,
  at: 1500,
});

describe('the stored shape', () => {
  it('reads a review file with `authored`, and the previous shape still reads', () => {
    const before = syncedReview(undefined, facts(), work, workReviewId(work, URL1), 1000);
    const disk = (review: Review) => JSON.parse(JSON.stringify({ version: 1, review }));
    expect(ReviewFileSchema.safeParse(disk(before)).success).toBe(true);
    expect(before.authored).toBeUndefined();

    const withAuthored = ReviewFileSchema.safeParse(disk({ ...before, authored: authored() }));
    expect(withAuthored.success).toBe(true);
    expect(withAuthored.data?.review.authored).toEqual(authored());

    // Strict like the rest of the record: an unknown key inside it, or a malformed head, refuses the file.
    expect(
      ReviewFileSchema.safeParse(disk({ ...before, authored: { ...authored(), extra: 1 } } as Review)).success
    ).toBe(false);
    expect(ReviewFileSchema.safeParse(disk({ ...before, authored: { ...authored(), headSha: 'abc' } })).success).toBe(
      false
    );
  });

  it('passes `authored` through to the view', () => {
    const review = { ...syncedReview(undefined, facts(), work, workReviewId(work, URL1), 1000), authored: authored() };
    expect(toView(review).authored).toEqual(authored());
  });

  it('a sync keeps `authored` unchanged: new words, a pushed head, and nothing new', () => {
    const id = workReviewId(work, URL1);
    const open = { ...stampSent(syncedReview(undefined, facts(), work, id, 1000), [], 1200), authored: authored() };
    expect(syncedReview(open, facts(), work, id, 2000)).toBe(open);
    const reworded = syncedReview(open, facts(SHA1, 'The item text, edited'), work, id, 2000);
    expect(reworded.walkthrough).toBe('The item text, edited');
    expect(reworded.authored).toEqual(authored());
    const pushed = syncedReview(reworded, facts(SHA2), work, id, 3000);
    expect(pushed).toMatchObject({ headSha: SHA2, revision: 2 });
    expect(pushed.authored).toEqual(authored());
  });
});

describe('a sync against a repository with an origin', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });
  const gitIn =
    (cwd: string) =>
    (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  it('keeps `authored` when the item is edited and when the branch moves', async () => {
    const author = temp('review-authored-author-');
    const a = gitIn(author);
    a('init', '-q', '-b', 'main');
    a('config', 'user.name', 't');
    a('config', 'user.email', 't@example.invalid');
    a('config', 'commit.gpgsign', 'false');
    writeFileSync(join(author, 'a.txt'), 'one\n');
    a('add', '.');
    a('commit', '-q', '-m', 'base');
    const origin = temp('review-authored-origin-');
    gitIn(origin)('init', '-q', '--bare', '-b', 'main');
    a('remote', 'add', 'origin', origin);
    a('push', '-q', 'origin', 'main');
    a('checkout', '-q', '-b', 'build/w-1');
    writeFileSync(join(author, 'b.txt'), 'new\n');
    a('add', '.');
    a('commit', '-q', '-m', 'work');
    a('push', '-q', 'origin', 'build/w-1');
    const repo = temp('review-authored-case-');
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });

    const workspace = workspaceForCase('review-authored-case');
    const reviews = createWorkReviews({
      casePath: async () => repo,
      dockerWorkspaces: async () => [],
      announce: () => undefined,
    });
    const ref = { workspaceId: workspace.id, number: 1 };
    const ctx = { author: { kind: 'human' as const, userId: 'admin' }, now: 1000 };
    const file = (patch: Record<string, unknown>) =>
      changeWork(workspace.id, (f) =>
        f.items.length
          ? updateWork(f, 1, UpdateWorkSchema.parse(patch), ctx)
          : createWork(f, CreateWorkSchema.parse({ title: 'Outline', status: 'in-progress', ...patch }), ctx)
      );

    file({ pr: { url: URL1, branch: 'build/w-1' } });
    const first = await reviews.sync(ref);
    if (!('review' in first)) throw new Error(JSON.stringify(first));
    const mine = authored(first.review.headSha);
    writeReview({ ...first.review, authored: mine });

    file({ description: 'The brief, edited after the walkthrough was written.' });
    const edited = await reviews.sync(ref);
    if (!('review' in edited)) throw new Error(JSON.stringify(edited));
    expect(edited.changed).toBe(true);
    expect(edited.review.walkthrough).toContain('edited after the walkthrough');
    expect(edited.review.authored).toEqual(mine);

    writeFileSync(join(author, 'b.txt'), 'newer\n');
    a('commit', '-q', '-am', 'more');
    a('push', '-q', 'origin', 'build/w-1');
    const pushed = await reviews.sync(ref);
    if (!('review' in pushed)) throw new Error(JSON.stringify(pushed));
    expect(pushed.review.revision).toBe(2);
    expect(pushed.review.headSha).not.toBe(mine.headSha);
    const stored = readReview(first.review.id);
    expect(stored.ok && stored.review.authored).toEqual(mine);
  });
});

describe('the review route', () => {
  afterEach(() => rmSync(dataPath('reviews'), { recursive: true, force: true }));

  it('returns `authored` on a read of a work review that carries it', async () => {
    const harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, { dockerWorkspaces: async () => [] })
    );
    try {
      // The workspace does not exist, so the read's sync answers a problem and the stored review is what is shown.
      const review = {
        ...syncedReview(undefined, facts(), work, workReviewId(work, URL1), 1000),
        authored: authored(),
      };
      writeReview(review);
      const res = await harness.app.inject({ url: `/api/reviews/${review.id}` });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.review.authored).toEqual(authored());
      expect(data.review.walkthrough).toBe('The item text');
      expect(data.review.repoRoot).toBeUndefined();
    } finally {
      await harness.app.close();
    }
  });
});
