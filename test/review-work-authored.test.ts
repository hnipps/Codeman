/**
 * @fileoverview An agent's `codeman agent review submit` on the branch of a Work item it builds writes the item's work
 * review (`authored`, release 2 of `docs/work-review-walkthroughs-spec.md`) instead of making a session review. Real
 * temporary repositories: a bare origin, the case's clone, and the session in a `git worktree` of that clone, so the
 * repository match goes through the shared git common dir. A walkthrough submitted before the item had its pull request
 * makes a session review, and the work review made when the pull request is set takes that session review over.
 *
 * Port: 0 (app.inject, no listener is used).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { createWork, CreateWorkSchema, updateWork, UpdateWorkSchema } from '../src/canvas/work.js';
import { changeWork } from '../src/canvas/work-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { putCapture, type Review } from '../src/reviews/review-model.js';
import { readReview, writeReview } from '../src/reviews/review-store.js';
import { authorWorkReview, syncedReview, workReviewId } from '../src/reviews/work-review-model.js';
import { createWorkReviews } from '../src/reviews/work-reviews.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

const URL1 = 'https://github.com/example/repo/pull/9';
const ctx = { author: { kind: 'human' as const, userId: 'admin' }, now: 1000 };
const SESSION = 'test-session-1';
const AGENT = { 'x-codeman-parent-session': SESSION };
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

/** The first 33 bytes of a PNG: the signature and an IHDR chunk that states the size. */
function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

describe('authorWorkReview', () => {
  const work = { workspaceId: 'ws-1', number: 3 };
  const SHA1 = '1'.repeat(40);
  const base = (): Review =>
    syncedReview(
      undefined,
      {
        repoRoot: '/repo',
        project: 'repo',
        branch: 'build/w-3',
        base: 'main',
        headSha: SHA1,
        title: 'Item title',
        walkthrough: 'The item text',
        owner: null,
      },
      work,
      workReviewId(work, URL1),
      1000
    );
  const author = { sessionId: 's-1', sessionName: 'w3-codeman' };
  const still = (name: string) => ({ name, ext: '.png' as const, width: 1, height: 1, bytes: 33, label: '', at: 1 });

  it('sets the agent walkthrough and leaves the tracker text, title, notes and revision alone', () => {
    const before = base();
    const after = authorWorkReview(before, { title: 'ignored', walkthrough: 'Mine\r\n' }, author, SHA1, 500);
    expect(after.authored).toEqual({ ...author, walkthrough: 'Mine\n', headSha: SHA1, at: 500 });
    expect(after).toMatchObject({ title: 'Item title', walkthrough: 'The item text', revision: 1, notes: [] });
    expect(after.updatedAt).toBe(1001);
  });

  it('keeps every still unless the submission names the ones to keep', () => {
    const a = putCapture(base(), still('a'));
    const two = a.ok ? putCapture(a.review, still('b')) : a;
    if (!two.ok) throw new Error('refused');
    const input = { title: 'T', walkthrough: 'W' };
    const names = (r: Review) => r.captures?.map((c) => c.name);
    expect(names(authorWorkReview(two.review, input, author, SHA1, 2000))).toEqual(['a', 'b']);
    expect(names(authorWorkReview(two.review, { ...input, captures: ['b'] }, author, SHA1, 2000))).toEqual(['b']);
    expect(authorWorkReview(two.review, { ...input, captures: [] }, author, SHA1, 2000).captures).toBeUndefined();
  });
});

let n = 0;
describe('submitting on a work item branch', () => {
  let harness: RouteTestHarness;
  let dev: (...args: string[]) => string;
  let devDir: string;
  let wt: (...args: string[]) => string;
  let wtDir: string;
  let repo: string;
  let workspaceId: string;
  let workReviews: ReturnType<typeof createWorkReviews>;

  beforeEach(async () => {
    devDir = temp('rwa-dev-');
    dev = gitIn(devDir);
    dev('init', '-q', '-b', 'main');
    dev('config', 'user.name', 't');
    dev('config', 'user.email', 't@example.invalid');
    dev('config', 'commit.gpgsign', 'false');
    writeFileSync(join(devDir, 'a.txt'), 'one\n');
    dev('add', '.');
    dev('commit', '-q', '-m', 'base');
    const origin = temp('rwa-origin-');
    gitIn(origin)('init', '-q', '--bare', '-b', 'main');
    dev('remote', 'add', 'origin', origin);
    dev('push', '-q', 'origin', 'main');
    dev('checkout', '-q', '-b', 'build/w-1');
    writeFileSync(join(devDir, 'b.txt'), 'new\n');
    dev('add', '.');
    dev('commit', '-q', '-m', 'the work');
    dev('push', '-q', 'origin', 'build/w-1');

    repo = temp('rwa-case-');
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
    const clone = gitIn(repo);
    clone('config', 'user.name', 't');
    clone('config', 'user.email', 't@example.invalid');
    clone('config', 'commit.gpgsign', 'false');
    wtDir = join(temp('rwa-wt-'), 'w');
    clone('worktree', 'add', '-q', '-b', 'build/w-1', wtDir, 'origin/build/w-1');
    wt = gitIn(wtDir);

    workspaceId = workspaceForCase(`rwa-case-${++n}`).id;
    const current = workspaceId;
    harness = await createRouteTestHarness((app, routeCtx) => {
      const announce = (r: { id: string; owner: string | null }) =>
        routeCtx.broadcast('review:changed', { id: r.id, owner: r.owner ?? '@single' });
      workReviews = createWorkReviews({
        // Earlier tests' workspaces claim the same branch name; only this test's has a repository.
        casePath: async (w) => (w.id === current ? repo : join(repo, 'missing')),
        dockerWorkspaces: async () => [],
        announce,
      });
      registerReviewPageRoutes(app, routeCtx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => null, readOverview: async () => ({}) as never, requestDeploy: async () => ({}) as never },
        workReviews,
      });
    });
    harness.ctx.sessions.get(SESSION)!.workingDir = wtDir;
  });
  afterEach(async () => {
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const item = (patch: Record<string, unknown>) =>
    changeWork(workspaceId, (f) =>
      f.items.length
        ? updateWork(f, 1, UpdateWorkSchema.parse(patch), ctx)
        : createWork(f, CreateWorkSchema.parse({ title: 'Outline', status: 'in-progress', ...patch }), ctx)
    );
  const id = () => workReviewId({ workspaceId, number: 1 }, URL1);
  const queue = async () => (await harness.app.inject({ url: '/api/reviews' })).json().data;
  const page = async () => (await harness.app.inject({ url: `/api/reviews/${id()}` })).json().data;
  const submit = (walkthrough = 'What I built', headers: Record<string, string> = AGENT, captures?: string[]) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers,
      payload: { title: 'Work', walkthrough, ...(captures ? { captures } : {}) },
    });
  const putStill = (reviewId: string, name: string, headers: Record<string, string> = AGENT) =>
    harness.app.inject({
      method: 'PUT',
      url: `/api/reviews/${reviewId}/captures/${name}`,
      headers: { ...headers, 'content-type': 'image/png' },
      payload: png(4, 3),
    });
  const linked = async () => {
    item({ pr: { url: URL1, branch: 'build/w-1' }, sessions: [SESSION] });
    expect(await workReviews.sync({ workspaceId, number: 1 })).toMatchObject({ changed: true });
  };
  const otherSession = (sessionId: string) => {
    harness.ctx.sessions.set(sessionId, { ...harness.ctx.sessions.get(SESSION)!, id: sessionId });
    return { 'x-codeman-parent-session': sessionId };
  };

  it('a linked session writes the walkthrough onto the work review and makes no session review', async () => {
    await linked();
    const sent = await submit('## What changed\n\nThe outline.');
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data).toEqual({ id: id(), revision: 1, state: 'ready', url: `reviews/${id()}` });
    const { review } = await page();
    expect(review.authored).toMatchObject({
      sessionId: SESSION,
      walkthrough: '## What changed\n\nThe outline.',
      headSha: gitIn(devDir)('rev-parse', 'HEAD'),
    });
    expect(review.walkthrough).toContain('Pull request: ' + URL1);
    expect((await queue()).waiting.map((r: { id: string }) => r.id)).toEqual([id()]);
  });

  it('refuses a session the item does not link, and a head origin does not have', async () => {
    item({ pr: { url: URL1, branch: 'build/w-1' } });
    const unlinked = await submit();
    expect(unlinked.statusCode).toBe(403);
    expect(unlinked.json().error).toMatch(/W-1.*canvas_work update/);

    item({ linkSessions: [SESSION] });
    writeFileSync(join(wtDir, 'b.txt'), 'local only\n');
    wt('commit', '-q', '-am', 'not pushed');
    const unpushed = await submit();
    expect(unpushed.statusCode).toBe(409);
    expect(unpushed.json().error).toMatch(/^UNPUSHED: push the branch, then submit/);
    // Neither refusal falls through to a session review.
    expect((await queue()).waiting).toEqual([]);
  });

  it('an item edit and the sync after it keep the agent walkthrough', async () => {
    await linked();
    await submit('Agent words');
    item({ description: 'A new description' });
    await workReviews.sync({ workspaceId, number: 1 });
    const { review } = await page();
    expect(review.walkthrough).toContain('A new description');
    expect(review.authored.walkthrough).toBe('Agent words');
  });

  it('takes stills from the authoring session only', async () => {
    await linked();
    const reviewId = (await submit()).json().data.id as string;
    expect((await putStill(reviewId, 'outline')).statusCode).toBe(200);
    expect((await page()).review.captures).toMatchObject([{ name: 'outline', width: 4, height: 3 }]);
    expect((await putStill(reviewId, 'other', otherSession('other-session-9'))).statusCode).toBe(403);
  });

  it('a resubmission after Request changes reads updated', async () => {
    await linked();
    await submit('First');
    await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id()}/notes`,
      payload: { at: { kind: 'general' }, text: 'Rename the heading' },
    });
    const sent = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id()}/request-changes` });
    expect(sent.json().data.review.state).toBe('changes-requested');
    const again = await submit('Renamed it');
    expect(again.json().data.state).toBe('updated');
    expect((await page()).review).toMatchObject({ state: 'updated', authored: { walkthrough: 'Renamed it' } });
  });

  it('refuses a decided work review', async () => {
    await linked();
    expect((await harness.app.inject({ method: 'POST', url: `/api/reviews/${id()}/close` })).statusCode).toBe(200);
    const refused = await submit();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/DECIDED/);
    expect((await page()).review.authored).toBeUndefined();
  });

  it('a branch no item claims still gets a session review', async () => {
    await linked();
    wt('checkout', '-q', '-b', 'feat/other');
    writeFileSync(join(wtDir, 'c.txt'), 'other\n');
    wt('add', '.');
    wt('commit', '-q', '-m', 'other');
    const sent = await submit('Other work');
    expect(sent.statusCode).toBe(201);
    const sessionReview = sent.json().data.id as string;
    expect(sessionReview).not.toBe(id());
    expect((await harness.app.inject({ url: `/api/reviews/${sessionReview}` })).json().data.review).toMatchObject({
      sessionId: SESSION,
      branch: 'feat/other',
      walkthrough: 'Other work',
    });
    expect((await page()).review.authored).toBeUndefined();
  });
  describe('a session review submitted before the item had its pull request', () => {
    const sessionReviewFirst = async () => {
      item({ sessions: [SESSION] });
      const sent = await submit('Walkthrough written first');
      expect(sent.statusCode).toBe(201);
      const sessionId = sent.json().data.id as string;
      expect((await putStill(sessionId, 'outline')).statusCode).toBe(200);
      const note = await harness.app.inject({
        method: 'POST',
        url: `/api/reviews/${sessionId}/notes`,
        payload: { at: { kind: 'capture', name: 'outline' }, text: 'Tighten the outline' },
      });
      expect(note.statusCode).toBe(200);
      return sessionId;
    };
    const setPr = () => item({ pr: { url: URL1, branch: 'build/w-1' } });

    it('is taken over by the work review: one open review with its walkthrough, stills and notes', async () => {
      const sessionId = await sessionReviewFirst();
      setPr();
      expect(await workReviews.sync({ workspaceId, number: 1 })).toMatchObject({ changed: true });

      const { review } = await page();
      expect(review.authored).toMatchObject({
        sessionId: SESSION,
        walkthrough: 'Walkthrough written first',
        headSha: gitIn(devDir)('rev-parse', 'HEAD'),
      });
      expect(review.captures).toMatchObject([{ name: 'outline', width: 4, height: 3 }]);
      expect(review.notes).toMatchObject([{ text: 'Tighten the outline', at: { kind: 'capture', name: 'outline' } }]);
      const still = await harness.app.inject({ url: `/api/reviews/${id()}/captures/outline` });
      expect(still.statusCode).toBe(200);
      expect(still.rawPayload.equals(png(4, 3))).toBe(true);

      const closed = (await harness.app.inject({ url: `/api/reviews/${sessionId}` })).json().data;
      expect(closed.review.decision).toMatchObject({ kind: 'closed', closedBy: id() });
      expect(closed.adopted).toBe(true);
      expect(closed.review.notes).toHaveLength(1);
      expect((await queue()).waiting.map((r: { id: string }) => r.id)).toEqual([id()]);
    });

    it('a resubmission after the takeover writes onto the work review and opens no session review', async () => {
      await sessionReviewFirst();
      setPr();
      await workReviews.sync({ workspaceId, number: 1 });
      const again = await submit('Second walkthrough');
      expect(again.statusCode).toBe(200);
      expect(again.json().data.id).toBe(id());
      expect((await page()).review.authored.walkthrough).toBe('Second walkthrough');
      expect((await queue()).waiting.map((r: { id: string }) => r.id)).toEqual([id()]);
    });

    it('two syncs at once make one work review and close the session review once', async () => {
      const sessionId = await sessionReviewFirst();
      setPr();
      const announced: Review[] = [];
      const racing = createWorkReviews({
        casePath: async () => repo,
        dockerWorkspaces: async () => [],
        announce: (r) => announced.push(r),
      });
      const ref = { workspaceId, number: 1 };
      const results = await Promise.all([racing.sync(ref), racing.sync(ref)]);
      expect(results.filter((r) => 'changed' in r && r.changed)).toHaveLength(1);
      expect(announced.filter((r) => r.id === sessionId)).toHaveLength(1);
      expect(announced.filter((r) => r.id === id())).toHaveLength(1);
      expect((await page()).review.authored.walkthrough).toBe('Walkthrough written first');
    });

    it('takes the newest of several, closes every one, and leaves another owner and branch alone', async () => {
      const newest = await sessionReviewFirst();
      const read = readReview(newest);
      if (!read.ok) throw new Error('missing');
      const { captures: _c, ...plain } = read.review;
      const older = { ...plain, id: 'aaaaaaaaaaaaaaa1', walkthrough: 'Older', notes: [], updatedAt: 1 };
      const foreign = { ...older, id: 'aaaaaaaaaaaaaaa2', owner: 'someone-else' };
      const elsewhere = { ...older, id: 'aaaaaaaaaaaaaaa3', branch: 'build/w-2' };
      for (const r of [older, foreign, elsewhere]) writeReview(r);
      setPr();
      await workReviews.sync({ workspaceId, number: 1 });

      expect((await page()).review.authored.walkthrough).toBe('Walkthrough written first');
      const decision = (rid: string) => {
        const r = readReview(rid);
        return r.ok ? r.review.decision : 'missing';
      };
      expect(decision(newest)).toMatchObject({ kind: 'closed', closedBy: id() });
      expect(decision(older.id)).toMatchObject({ kind: 'closed', closedBy: id() });
      expect(decision(foreign.id)).toBeUndefined();
      expect(decision(elsewhere.id)).toBeUndefined();
    });

    it('a session review closed by an Approve of the work review does not read as taken over', async () => {
      await linked();
      const work = readReview(id());
      if (!work.ok) throw new Error('missing');
      const superseded = {
        ...work.review,
        id: 'aaaaaaaaaaaaaaa4',
        sessionId: SESSION,
        sessionName: 'w1',
        decision: { kind: 'closed' as const, at: work.review.createdAt + 5000, closedBy: id() },
      };
      writeReview(superseded);
      const closed = (await harness.app.inject({ url: `/api/reviews/${superseded.id}` })).json().data;
      expect(closed.adopted).toBe(false);
    });
  });
});
