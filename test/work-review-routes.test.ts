/**
 * @fileoverview The Reviews routes for a work item's pull request: the queue joins the tracker, the page read notices a
 * push, Request changes writes the item, and Approve merges what origin has and marks the item done. Real temporary
 * repositories with a bare origin; the deploy supervisor is absent.
 *
 * Port: 0 (app.inject, no listener is used).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { createWork, CreateWorkSchema, updateWork, UpdateWorkSchema } from '../src/canvas/work.js';
import { changeWork, readWork } from '../src/canvas/work-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { workReviewId } from '../src/reviews/work-review-model.js';
import { createWorkReviews } from '../src/reviews/work-reviews.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

vi.mock('../src/canvas/conversation-delivery.js', async (original) => ({
  ...(await original<typeof import('../src/canvas/conversation-delivery.js')>()),
  deliver: vi.fn(async () => 'confirmed'),
}));
const { deliver } = await import('../src/canvas/conversation-delivery.js');

const URL1 = 'https://github.com/example/repo/pull/7';
const ctx = { author: { kind: 'human' as const, userId: 'admin' }, now: 1000 };
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

let n = 0;
describe('work review routes', () => {
  let harness: RouteTestHarness;
  let author: (...args: string[]) => string;
  let authorDir: string;
  let origin: string;
  let workspaceId: string;
  const announceWork = vi.fn();
  let workReviews: ReturnType<typeof createWorkReviews>;

  beforeEach(async () => {
    authorDir = temp('wrr-author-');
    author = gitIn(authorDir);
    author('init', '-q', '-b', 'main');
    author('config', 'user.name', 't');
    author('config', 'user.email', 't@example.invalid');
    author('config', 'commit.gpgsign', 'false');
    writeFileSync(join(authorDir, 'a.txt'), 'one\n');
    author('add', '.');
    author('commit', '-q', '-m', 'base');
    origin = temp('wrr-origin-');
    gitIn(origin)('init', '-q', '--bare', '-b', 'main');
    author('remote', 'add', 'origin', origin);
    author('push', '-q', 'origin', 'main');
    author('checkout', '-q', '-b', 'build/w-1');
    writeFileSync(join(authorDir, 'b.txt'), 'new\n');
    author('add', '.');
    author('commit', '-q', '-m', 'the work');
    author('push', '-q', 'origin', 'build/w-1');
    const repo = temp('wrr-case-');
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
    const clone = gitIn(repo);
    clone('config', 'user.name', 't');
    clone('config', 'user.email', 't@example.invalid');
    clone('config', 'commit.gpgsign', 'false');
    // A stale local branch of the same name: the review must read origin's.
    clone('branch', 'build/w-1', 'main');
    workspaceId = workspaceForCase(`wrr-case-${++n}`).id;
    harness = await createRouteTestHarness((app, routeCtx) => {
      const announce = (r: { id: string; owner: string | null }) =>
        routeCtx.broadcast('review:changed', { id: r.id, owner: r.owner ?? '@single' });
      workReviews = createWorkReviews({
        casePath: async () => repo,
        dockerWorkspaces: async () => [],
        announce,
        announceWork,
      });
      registerReviewPageRoutes(app, routeCtx, {
        dockerWorkspaces: async () => [],
        deploy: { cli: () => null, readOverview: vi.fn(), requestDeploy: vi.fn() },
        announceWork,
        workReviews,
      });
    });
    vi.mocked(deliver).mockClear();
    announceWork.mockClear();
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
  /** What following item writes does in the server: the item is written, then synced. */
  const opened = async () => {
    item({ pr: { url: URL1, branch: 'build/w-1' } });
    expect(await workReviews.sync({ workspaceId, number: 1 })).toMatchObject({ changed: true });
    return page();
  };

  it('joins the queue while the item wants it, with the item and its link', async () => {
    item({ pr: { url: URL1 } });
    expect((await harness.app.inject({ url: `/api/reviews/${id()}` })).statusCode).toBe(404);
    const one = await opened();
    expect(one.review).toMatchObject({ id: id(), sessionName: 'W-1', branch: 'build/w-1', state: 'ready' });
    expect(one.review.headSha).toBe(author('rev-parse', 'HEAD'));
    expect(one).toMatchObject({ sessionLive: false, work: { key: 'W-1', prUrl: URL1, wanted: true } });
    expect((await queue()).waiting).toMatchObject([{ id: id(), work: { key: 'W-1', prUrl: URL1 } }]);

    item({ status: 'not-doing' });
    expect((await queue()).waiting).toEqual([]);
    item({ status: 'in-progress' });
    expect((await queue()).waiting).toHaveLength(1);
    item({ pr: null });
    expect((await queue()).waiting).toEqual([]);
  });

  it('notices a push when the page is read, fetching at most once a minute', async () => {
    item({ pr: { url: URL1, branch: 'build/w-1' } });
    await workReviews.sync({ workspaceId, number: 1 });
    writeFileSync(join(authorDir, 'b.txt'), 'pushed\n');
    author('commit', '-q', '-am', 'push');
    author('push', '-q', 'origin', 'build/w-1');
    const read = await page();
    expect(read.review).toMatchObject({ revision: 2, headSha: author('rev-parse', 'HEAD') });
    writeFileSync(join(authorDir, 'b.txt'), 'again\n');
    author('commit', '-q', '-am', 'again');
    author('push', '-q', 'origin', 'build/w-1');
    expect((await page()).review.revision).toBe(2);
    expect((await queue()).waiting).toHaveLength(1);
  });

  it('shows the pull request changes from origin, not the stale local branch', async () => {
    await opened();
    const changes = (await harness.app.inject({ url: `/api/reviews/${id()}/changes` })).json().data;
    expect(changes).toMatchObject({ gone: false, moved: false, headSha: author('rev-parse', 'HEAD') });
    expect(changes.files.map((f: { path: string }) => f.path)).toEqual(['b.txt']);
  });

  it('Request changes puts the notes on the item and pastes nowhere; a push then reads as updated', async () => {
    const one = await opened();
    const note = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id()}/notes`,
      payload: { at: { kind: 'general' }, text: 'Rename the heading' },
    });
    expect(note.statusCode).toBe(200);
    const sent = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id()}/request-changes` });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data).toMatchObject({
      work: { key: 'W-1', position: 1 },
      review: { state: 'changes-requested' },
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(announceWork).toHaveBeenCalledWith(workspaceId);
    const read = readWork(workspaceId);
    const stored = read.ok ? read.file.items[0] : undefined;
    expect(stored).toMatchObject({ status: 'ready-for-work' });
    expect(stored?.changes?.text).toContain('Rename the heading');
    expect(stored?.changes?.text).toContain('push it to origin (build/w-1), then report on W-1');

    // The agent pushes to the same branch.
    writeFileSync(join(authorDir, 'b.txt'), 'renamed\n');
    author('commit', '-q', '-am', 'rename');
    author('push', '-q', 'origin', 'build/w-1');
    // Approve fetches first, so it sees the push and refuses the commit the person had read.
    const after = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id()}/approve`,
      payload: { headSha: stored?.changes ? one.review.headSha : '' },
    });
    expect(after.json().error).toMatch(/MOVED/);
    expect((await page()).review).toMatchObject({ state: 'updated', revision: 2 });
  });

  it('Approve merges the origin tip into the base and marks the item done', async () => {
    const one = await opened();
    const approved = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id()}/approve`,
      payload: { headSha: one.review.headSha },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.review).toMatchObject({ state: 'merged' });
    expect(gitIn(origin)('show', 'main:b.txt')).toBe('new');
    const read = readWork(workspaceId);
    const stored = read.ok ? read.file.items[0] : undefined;
    expect(stored).toMatchObject({ status: 'done' });
    expect(stored?.history[0]?.text).toMatch(/^Approved and merged [0-9a-f]{7} in review$/);
    expect((await queue()).decided).toMatchObject([{ id: id(), work: { key: 'W-1', wanted: false } }]);
  });

  it('refuses Approve once the item no longer asks for the review', async () => {
    const one = await opened();
    item({ pr: null });
    const refused = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id()}/approve`,
      payload: { headSha: one.review.headSha },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/GONE/);
    expect(gitIn(origin)('rev-parse', 'main')).not.toBe(one.review.headSha);
  });
});
