/**
 * The Reviews page: the pure rules (`src/reviews/review-model.ts`), the git reader against a real temporary
 * repository (`review-git.ts`), and the routes (`src/web/routes/review-routes.ts`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath, getDataDir } from '../src/config/instance.js';
import { deployRole } from '../src/deploy-role.js';
import {
  parseNumstatZ,
  repoFacts,
  reviewChanges,
  reviewFileDiff,
  ReviewGitRefusal,
} from '../src/reviews/review-git.js';
import {
  addNote,
  mayAddCaptures,
  patchNote,
  queueOf,
  removeNote,
  requestChangesPrompt,
  reviewState,
  sameWork,
  stampSent,
  submitReview,
  toView,
  unsentNotes,
  type Review,
} from '../src/reviews/review-model.js';
import { readReview, writeReview } from '../src/reviews/review-store.js';
import { readSwarm } from '../src/reviews/swarm-store.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import type { Webview } from '../src/types/webview.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';
import { writeWebviews } from '../src/webview-store.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/mock-session.js';
import { changeWork, readWork } from '../src/canvas/work-store.js';
import { createWork } from '../src/canvas/work.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';

vi.mock('../src/canvas/conversation-delivery.js', async (original) => ({
  ...(await original<typeof import('../src/canvas/conversation-delivery.js')>()),
  deliver: vi.fn(async () => 'confirmed'),
}));
const { deliver } = await import('../src/canvas/conversation-delivery.js');

const SHA = 'a'.repeat(40);
const facts = { repoRoot: '/repo', project: 'repo', branch: 'feat/x', base: 'main', headSha: SHA };
const author = { owner: null, sessionId: 'sess-1', sessionName: 'w4' };
const fresh = (): Review =>
  submitReview(undefined, { title: 'T', walkthrough: 'Hello world' }, facts, author, 'aaaaaaaa', 1000);

describe('review rules', () => {
  it('cleans what an agent submits', () => {
    const r = submitReview(
      undefined,
      { title: '  A\ttitle\nwith\u0007 a bell  ', walkthrough: 'line\r\nnext\u001b[31m' },
      facts,
      author,
      'aaaaaaaa',
      1
    );
    expect(r.title).toBe('A title with a bell');
    expect(r.walkthrough).toBe('line\nnext[31m');
  });

  it('a resubmission replaces the walkthrough, keeps the notes and counts a revision', () => {
    const noted = addNote(fresh(), { at: { kind: 'general' }, text: 'why?' }, 'bbbbbbbb', 1100);
    if (!noted.ok) throw new Error('expected a note');
    const again = submitReview(
      noted.review,
      { title: 'T2', walkthrough: 'Second' },
      { ...facts, headSha: 'b'.repeat(40) },
      author,
      'cccccccc',
      2000
    );
    expect(again.id).toBe('aaaaaaaa');
    expect(again.revision).toBe(2);
    expect(again.walkthrough).toBe('Second');
    expect(again.notes).toHaveLength(1);
    expect(again.headSha).toBe('b'.repeat(40));
  });

  it('a resubmission from another session of the owner makes that session the author', () => {
    const again = submitReview(
      fresh(),
      { title: 'T', walkthrough: 'Second' },
      facts,
      { owner: null, sessionId: 'sess-2', sessionName: 'w5' },
      'cccccccc',
      2000
    );
    expect(again).toMatchObject({ id: 'aaaaaaaa', revision: 2, sessionId: 'sess-2', sessionName: 'w5' });
    expect(mayAddCaptures(again, 'sess-2')).toBe(true);
    expect(mayAddCaptures(again, 'sess-1')).toBe(false);
  });

  it('the same work is the owner, repository and branch of a session review, whichever session sent it', () => {
    const r = fresh();
    expect(sameWork(r, null, facts)).toBe(true);
    expect(sameWork({ ...r, sessionId: 'sess-2' }, null, facts)).toBe(true);
    expect(sameWork(r, 'bob', facts)).toBe(false);
    expect(sameWork(r, null, { ...facts, branch: 'feat/y' })).toBe(false);
    expect(sameWork(r, null, { ...facts, repoRoot: '/other' })).toBe(false);
    expect(sameWork({ ...r, sessionId: 'work:ws1:7', sessionName: 'W-7' }, null, facts)).toBe(false);
  });

  it('moves ready → changes requested → updated', () => {
    let r = fresh();
    expect(reviewState(r)).toBe('ready');
    const noted = addNote(r, { at: { kind: 'general' }, text: 'fix it' }, 'bbbbbbbb', 1100);
    if (!noted.ok) throw new Error('expected a note');
    r = stampSent(noted.review, ['bbbbbbbb'], 1200);
    expect(reviewState(r)).toBe('changes-requested');
    expect(unsentNotes(r)).toHaveLength(0);
    r = submitReview(r, { title: 'T', walkthrough: 'Fixed' }, facts, author, 'x', 1300);
    expect(reviewState(r)).toBe('updated');
  });

  it('a sent note can be resolved but not edited or deleted', () => {
    const noted = addNote(fresh(), { at: { kind: 'general' }, text: 'fix it' }, 'bbbbbbbb', 1100);
    if (!noted.ok) throw new Error('expected a note');
    const sent = stampSent(noted.review, ['bbbbbbbb'], 1200);
    expect(patchNote(sent, 'bbbbbbbb', { text: 'other' }, 1300)).toMatchObject({ ok: false, code: 'SENT' });
    expect(removeNote(sent, 'bbbbbbbb')).toMatchObject({ ok: false, code: 'SENT' });
    const resolved = patchNote(sent, 'bbbbbbbb', { resolved: true }, 1300);
    expect(resolved.ok && resolved.review.notes[0]?.resolvedAt).toBe(1300);
    const reopened = resolved.ok ? patchNote(resolved.review, 'bbbbbbbb', { resolved: false }, 1400) : resolved;
    expect(reopened.ok && 'resolvedAt' in reopened.review.notes[0]!).toBe(false);
  });

  it('a decided review takes no more notes and leaves the waiting list', () => {
    const decided: Review = { ...fresh(), decision: { kind: 'merged', at: 5000 } };
    expect(addNote(decided, { at: { kind: 'general' }, text: 'late' }, 'bbbbbbbb', 6000)).toMatchObject({
      ok: false,
      code: 'DECIDED',
    });
    const queue = queueOf([decided, { ...fresh(), id: 'dddddddd' }], 6000);
    expect(queue.waiting.map((r) => r.id)).toEqual(['dddddddd']);
    expect(queue.decided.map((r) => r.id)).toEqual(['aaaaaaaa']);
    expect(queueOf([decided], 5000 + 25 * 60 * 60 * 1000).decided).toEqual([]);
  });

  it('builds one prompt that names where each note sits', () => {
    let r = fresh();
    const add = (at: Parameters<typeof addNote>[1]['at'], text: string, id: string) => {
      const next = addNote(r, { at, text }, id, 1100);
      if (!next.ok) throw new Error('expected a note');
      r = next.review;
    };
    add({ kind: 'general' }, 'Overall fine', 'n1aaaaaa');
    add({ kind: 'text', anchor: { quote: 'Hello', prefix: '', suffix: ' world' } }, 'Say more', 'n2aaaaaa');
    add({ kind: 'code', path: 'src/a.ts', line: 12, side: 'new', text: 'const a = 1;' }, 'Rename', 'n3aaaaaa');
    add({ kind: 'preview', path: '/settings' }, 'Too dark', 'n4aaaaaa');
    add(
      {
        kind: 'preview',
        path: '/settings',
        element: {
          selector: 'main > button.save',
          trail: 'main > button',
          tag: 'button',
          text: 'Save\u001b[31m\nnow',
          x: 4,
          y: 8,
        },
      },
      'Wrong colour',
      'n5aaaaaa'
    );
    const prompt = requestChangesPrompt(r, unsentNotes(r));
    if (!('text' in prompt)) throw new Error('expected a prompt');
    expect(prompt.text).toContain('1. General');
    expect(prompt.text).toContain('2. On your walkthrough, at "Hello"');
    expect(prompt.text).toContain('3. On src/a.ts:12, `const a = 1;`');
    expect(prompt.text).toContain('4. On the preview at /settings\n');
    // What the page wrote about its own element reaches the prompt as one plain line.
    expect(prompt.text).toContain(
      '5. On the preview at /settings, the element <button> "Save[31m now" (selector `main > button.save`)'
    );
    expect(prompt.text).toContain('Do not merge or deploy');
    expect(requestChangesPrompt(r, [])).toMatchObject({ refusal: expect.stringContaining('NOTHING') });
  });

  it('never sends the path on this machine to a browser', () => {
    expect(JSON.stringify(toView(fresh()))).not.toContain('/repo');
  });

  it('parses numstat -z, renames and binaries included, and drops unsafe paths', () => {
    const out = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', '1\t1\t../escape', ''].join('\0');
    expect(parseNumstatZ(out)).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1, binary: false },
      { path: 'img.png', added: 0, deleted: 0, binary: true },
      { path: 'new.ts', origPath: 'old.ts', added: 2, deleted: 0, binary: false },
    ]);
  });
});

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-repo-')));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(join(dir, 'b.txt'), 'new\n');
  git('add', '.');
  git('commit', '-q', '-m', 'work');
  return dir;
}

const local = (branch: string) => ({ from: 'local-first' as const, branch });

describe('review git reader', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reads the branch, its base and what it changes', async () => {
    const f = await repoFacts(repo, undefined);
    expect(f).toMatchObject({ repoRoot: repo, branch: 'feat/x', base: 'main' });
    const changes = await reviewChanges(repo, f.base, local(f.branch));
    expect(changes).toMatchObject({ commits: 1, added: 2, deleted: 1, gone: false, headSha: f.headSha });
    expect(changes.files.map((x) => x.path)).toEqual(['a.txt', 'b.txt']);
    const diff = await reviewFileDiff(repo, f.base, local(f.branch), { path: 'a.txt' });
    expect(diff?.diff).toContain('-two\n+TWO');
  });

  it('refuses the base branch itself, an unknown base, and an option-shaped name', async () => {
    await expect(repoFacts(repo, 'feat/x')).rejects.toBeInstanceOf(ReviewGitRefusal);
    await expect(repoFacts(repo, 'nope')).rejects.toThrow(/NO_BASE/);
    expect((await reviewChanges(repo, '--output=/tmp/x', local('feat/x'))).gone).toBe(true);
    expect(await reviewFileDiff(repo, 'main', local('feat/x'), { path: '../a.txt' })).toBeNull();
  });

  it('compares with the base fetched from origin when the local base is behind it', async () => {
    const dir = makeRepo();
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      // The work was branched from what origin has; the local base branch never caught up.
      git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'feat/x'));
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'more');
      writeFileSync(join(dir, 'c.txt'), 'c\n');
      git('add', 'c.txt');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'the work');
      const changes = await reviewChanges(dir, 'main', local('feat/x'));
      expect(changes.files.map((x) => x.path)).toEqual(['c.txt']);
      expect(changes.commits).toBe(2);
      expect((await reviewFileDiff(dir, 'main', local('feat/x'), { path: 'a.txt' }))?.diff ?? '').toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a deleted branch as gone', async () => {
    expect(await reviewChanges(repo, 'main', local('feat/missing'))).toMatchObject({ gone: true, files: [] });
  });
});

describe('review routes', () => {
  let repo: string;
  let harness: RouteTestHarness;
  const AGENT = { 'x-codeman-parent-session': 'test-session-1' };

  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(async () => {
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, { dockerWorkspaces: async () => [] })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo;
    vi.mocked(deliver).mockClear();
    vi.mocked(deliver).mockResolvedValue('confirmed');
  });
  afterEach(async () => {
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  const submit = (headers: Record<string, string> = AGENT, walkthrough = 'See [a](#code=a.txt:2)') =>
    harness.app.inject({ method: 'POST', url: '/api/reviews', headers, payload: { title: 'Work', walkthrough } });

  it('only the session that did the work submits, and a second submit updates the same review', async () => {
    expect((await submit({})).statusCode).toBe(403);
    expect((await submit({ 'x-codeman-parent-session': 'nobody-here' })).statusCode).toBe(403);
    const first = await submit();
    expect(first.statusCode).toBe(201);
    const id = first.json().data.id as string;
    const second = await submit(AGENT, 'Updated');
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ id, revision: 2 });
    const files = () => readdirSync(dataPath('reviews')).filter((n) => n.endsWith('.json'));
    expect(files().filter((n) => !n.endsWith('.swarm.json'))).toHaveLength(1);
    expect(harness.ctx.broadcast).toHaveBeenCalledWith('review:changed', { id, owner: '@single' });
    // Both submits reached the route's own pr-swarm runner: one run, queued by the first, joined by the second.
    await vi.waitFor(() => expect(files()).toContain(`${id}.swarm.json`));
    await vi.waitFor(() => {
      const runs = readSwarm(id);
      expect(runs.ok && runs.file.runs).toMatchObject([{ state: 'queued', trigger: 'submit' }]);
    });

    const queue = (await harness.app.inject({ url: '/api/reviews' })).json().data;
    expect(queue.waiting).toHaveLength(1);
    const one = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data;
    expect(one.review).toMatchObject({ title: 'Work', branch: 'feat/x', base: 'main', state: 'ready' });
    expect(one.review.repoRoot).toBeUndefined();
    expect(JSON.stringify(one)).not.toContain(repo);
  });

  it('a submit of the branch from another session of the owner updates the open review and moves its author', async () => {
    const other = createMockSession('test-session-2');
    other.name = 'w9';
    other.workingDir = repo;
    harness.ctx.sessions.set(other.id, other as never);
    const first = await submit();
    expect(first.statusCode).toBe(201);
    const id = first.json().data.id as string;
    await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/notes`,
      payload: { at: { kind: 'general' }, text: 'Keep me' },
    });
    const second = await submit({ 'x-codeman-parent-session': 'test-session-2' }, 'From the second worker');
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ id, revision: 2 });
    const reviews = readdirSync(dataPath('reviews')).filter((n) => n.endsWith('.json') && !n.endsWith('.swarm.json'));
    expect(reviews).toHaveLength(1);
    const one = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
    expect(one).toMatchObject({
      sessionId: 'test-session-2',
      sessionName: 'w9',
      walkthrough: 'From the second worker',
    });
    expect(one.notes).toHaveLength(1);
  });

  it('where two open reviews of the branch already exist, each session updates its own', async () => {
    const other = createMockSession('test-session-2');
    other.workingDir = repo;
    Object.assign(other, { owner: 'bob' });
    harness.ctx.sessions.set(other.id, other as never);
    // Two open reviews of one owner's branch, as a release before W-77 could leave them.
    const theirs = (await submit({ 'x-codeman-parent-session': 'test-session-2' })).json().data.id as string;
    const mine = (await submit()).json().data.id as string;
    const read = readReview(theirs);
    if (!read.ok) throw new Error('review not written');
    writeReview({ ...read.review, owner: null });
    Object.assign(other, { owner: undefined });

    for (const [headers, id] of [
      [AGENT, mine],
      [{ 'x-codeman-parent-session': 'test-session-2' }, theirs],
    ] as const) {
      const again = await submit(headers, 'Again');
      expect(again.statusCode).toBe(200);
      expect(again.json().data).toMatchObject({ id, revision: 2 });
    }
  });

  it('where two open reviews of the branch exist and neither is the caller’s, the newest is updated, a tie to the higher id', async () => {
    const other = createMockSession('test-session-2');
    other.workingDir = repo;
    Object.assign(other, { owner: 'bob' });
    harness.ctx.sessions.set(other.id, other as never);
    const third = createMockSession('test-session-3');
    third.workingDir = repo;
    harness.ctx.sessions.set(third.id, third as never);
    // Two open reviews of one owner's branch, as a release before W-77 could leave them.
    const a = (await submit({ 'x-codeman-parent-session': 'test-session-2' })).json().data.id as string;
    const b = (await submit()).json().data.id as string;
    const stamp = (id: string, updatedAt: number, owner: string | null = null) => {
      const read = readReview(id);
      if (!read.ok) throw new Error('review not written');
      writeReview({ ...read.review, owner, updatedAt });
    };
    const caller = { 'x-codeman-parent-session': 'test-session-3' };

    stamp(a, 5000);
    stamp(b, 4000);
    const newest = await submit(caller, 'Newest');
    expect(newest.statusCode).toBe(200);
    expect(newest.json().data.id).toBe(a);

    // The update moved `a` to the caller; put both back on other sessions with equal times.
    const tie = 9_000_000_000_000;
    for (const [id, sessionId] of [
      [a, 'test-session-2'],
      [b, 'test-session-1'],
    ] as const) {
      const read = readReview(id);
      if (!read.ok) throw new Error('review not written');
      writeReview({ ...read.review, owner: null, sessionId, updatedAt: tie });
    }
    const tied = await submit(caller, 'Tied');
    expect(tied.statusCode).toBe(200);
    expect(tied.json().data.id).toBe(a > b ? a : b);
  });

  it('a submit of the branch by another owner, or after a decision, opens a new review', async () => {
    const other = createMockSession('test-session-2');
    other.workingDir = repo;
    Object.assign(other, { owner: 'bob' });
    harness.ctx.sessions.set(other.id, other as never);
    const first = (await submit()).json().data.id as string;
    const bobs = await submit({ 'x-codeman-parent-session': 'test-session-2' });
    expect(bobs.statusCode).toBe(201);
    expect(bobs.json().data.id).not.toBe(first);

    expect((await harness.app.inject({ method: 'POST', url: `/api/reviews/${first}/close` })).statusCode).toBe(200);
    const after = await submit();
    expect(after.statusCode).toBe(201);
    expect(after.json().data.id).not.toBe(first);
  });

  it('serves the changes, and a diff only for a file the branch changed', async () => {
    const id = (await submit()).json().data.id as string;
    const changes = (await harness.app.inject({ url: `/api/reviews/${id}/changes` })).json().data;
    expect(changes).toMatchObject({ moved: false, gone: false });
    expect(changes.files).toHaveLength(2);
    const diff = await harness.app.inject({ url: `/api/reviews/${id}/diff?path=a.txt` });
    expect(diff.json().data.diff).toContain('+TWO');
    expect((await harness.app.inject({ url: `/api/reviews/${id}/diff?path=.git/config` })).statusCode).toBe(404);
    expect((await harness.app.inject({ url: `/api/reviews/zzzzzzzz/changes` })).statusCode).toBe(404);
  });

  it('refuses a submit from a repository inside a Docker case, and when the Docker list is unreadable', async () => {
    await harness.app.close();
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, { dockerWorkspaces: async () => [repo] })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo;
    const inside = await submit();
    expect(inside.statusCode).toBe(400);
    expect(inside.json().error).toContain('Docker');
    await harness.app.close();
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => {
          throw new Error('unreadable');
        },
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo;
    expect((await submit()).statusCode).toBe(400);
    expect(existsSync(dataPath('reviews'))).toBe(false);
  });

  it('notes are a person’s: an agent is refused, and Request changes sends them once', async () => {
    const id = (await submit()).json().data.id as string;
    const note = { at: { kind: 'code', path: 'a.txt', line: 2, side: 'new', text: 'TWO' }, text: 'Lower case?' };
    const byAgent = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/notes`,
      headers: AGENT,
      payload: note,
    });
    expect(byAgent.statusCode).toBe(403);
    const added = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/notes`, payload: note });
    expect(added.statusCode).toBe(200);
    expect(added.json().data.review.unsent).toBe(1);

    const agentSend = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/request-changes`,
      headers: AGENT,
      payload: {},
    });
    expect(agentSend.statusCode).toBe(403);
    expect(deliver).not.toHaveBeenCalled();

    const sent = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/request-changes`, payload: {} });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data).toMatchObject({ confirmed: true, review: { state: 'changes-requested', unsent: 0 } });
    expect(deliver).toHaveBeenCalledTimes(1);

    const again = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/request-changes`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('NOTHING');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('stamps nothing when the prompt never reached the session', async () => {
    const id = (await submit()).json().data.id as string;
    await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/notes`,
      payload: { at: { kind: 'general' }, text: 'x' },
    });
    vi.mocked(deliver).mockResolvedValue('not-written');
    const sent = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/request-changes`, payload: {} });
    expect(sent.statusCode).toBe(409);
    const one = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data;
    expect(one.review).toMatchObject({ state: 'ready', unsent: 1 });
  });

  it('opens only the review session’s own preview, through a capability that carries the frame bridge', async () => {
    const id = (await submit()).json().data.id as string;
    const tab = (webviewId: string, sessionId: string): Webview => ({
      id: webviewId,
      name: 'web',
      url: 'http://127.0.0.1:9/',
      embedMode: 'proxy',
      trusted: false,
      origin: { kind: 'session', sessionId, name: 'web' },
      createdAt: 1,
    });
    await writeWebviews(getDataDir(), [tab('wv-own', 'test-session-1'), tab('wv-other', 'someone-else')]);
    const open = (webviewId: string, headers: Record<string, string> = {}) =>
      harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/preview`, headers, payload: { webviewId } });

    expect((await open('wv-other')).statusCode).toBe(404);
    expect((await open('wv-missing')).statusCode).toBe(404);
    expect((await open('wv-own', AGENT)).statusCode).toBe(403);
    const opened = await open('wv-own');
    expect(opened.statusCode).toBe(200);
    const cap = /^\/webview\/([^/]+)\/$/.exec(opened.json().data.embedUrl)?.[1] ?? '';
    expect(webviewCapabilities.resolve(cap)).toMatchObject({ webviewId: 'wv-own', bridge: true });
    // The dashboard's own tab on the same preview is another token, and it carries no bridge.
    const plain = webviewCapabilities.mint('wv-own', undefined);
    expect(plain).not.toBe(cap);
    expect(webviewCapabilities.resolve(plain)?.bridge).toBeUndefined();
    expect(webviewCapabilities.mint('wv-own', undefined, { bridge: true })).toBe(cap);
    webviewCapabilities.revokeWebview('wv-own');
    expect(webviewCapabilities.resolve(cap)).toBeUndefined();
    expect(webviewCapabilities.resolve(plain)).toBeUndefined();
  });

  it('writes nothing on a colour that is not live', async () => {
    const id = (await submit()).json().data.id as string;
    vi.spyOn(deployRole, 'allows').mockReturnValue(false);
    try {
      expect((await submit(AGENT, 'again')).statusCode).toBe(409);
      const note = await harness.app.inject({
        method: 'POST',
        url: `/api/reviews/${id}/notes`,
        payload: { at: { kind: 'general' }, text: 'x' },
      });
      expect(note.statusCode).toBe(409);
      const read = await harness.app.inject({ url: `/api/reviews/${id}` });
      expect(read.json().data.review.revision).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('handing a review to a new session', () => {
  let repo: string;
  let harness: RouteTestHarness;
  const AGENT = { 'x-codeman-parent-session': 'test-session-1' };
  const startSession = vi.fn();
  const discardSession = vi.fn(async () => {});
  const announceWork = vi.fn();

  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(async () => {
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        startSession,
        discardSession,
        announceWork,
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo;
    startSession.mockReset();
    startSession.mockImplementation(async () => {
      const fresh = createMockSession('new-session-1');
      fresh.name = 'w9';
      fresh.workingDir = repo;
      harness.ctx.sessions.set(fresh.id, fresh as never);
      return { ok: true, sessionId: fresh.id };
    });
    discardSession.mockClear();
    announceWork.mockClear();
    vi.mocked(deliver).mockClear();
    vi.mocked(deliver).mockResolvedValue('confirmed');
  });
  afterEach(async () => {
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
    rmSync(dataPath('canvas'), { recursive: true, force: true });
    rmSync(dataPath('workspaces.json'), { force: true });
  });

  /** A review by test-session-1 with one note, a work item linking that session, and the session then gone. */
  const ended = async () => {
    const id = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/reviews',
        headers: AGENT,
        payload: { title: 'Work', walkthrough: 'I changed a.txt and added b.txt.' },
      })
    ).json().data.id as string;
    await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/notes`,
      payload: { at: { kind: 'code', path: 'a.txt', line: 2, side: 'new', text: 'TWO' }, text: 'Lower case?' },
    });
    const workspace = workspaceForCase('review-case');
    const filed = changeWork(workspace.id, (file) =>
      createWork(
        file,
        { title: 'Shout less', status: 'in-progress', description: 'Make a.txt calmer.', sessions: ['test-session-1'] },
        { author: { kind: 'human', userId: 'admin' }, now: 1 }
      )
    );
    if (!filed.ok) throw new Error('expected a work item');
    harness.ctx.sessions.delete('test-session-1');
    return { id, workspaceId: workspace.id };
  };
  const handOver = (id: string, headers: Record<string, string> = {}) =>
    harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/new-session`, headers, payload: {} });

  it('refuses while the author session still runs, and refuses an agent', async () => {
    const id = (
      await harness.app.inject({
        method: 'POST',
        url: '/api/reviews',
        headers: AGENT,
        payload: { title: 'Work', walkthrough: 'x' },
      })
    ).json().data.id as string;
    const live = await handOver(id);
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toContain('SESSION_LIVE');
    expect((await handOver(id, AGENT)).statusCode).toBe(403);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('starts a session in the branch folder and sends it the whole review, then moves the review to it', async () => {
    const { id, workspaceId } = await ended();
    const res = await handOver(id);
    expect(res.statusCode).toBe(200);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0][1]).toMatchObject({ workingDir: repo, mode: 'claude' });
    const data = res.json().data;
    expect(data).toMatchObject({
      sessionId: 'new-session-1',
      sessionName: 'w9',
      confirmed: true,
      work: ['W-1'],
      review: { sessionId: 'new-session-1', sessionName: 'w9', state: 'changes-requested', unsent: 0 },
    });

    const text = await deliveredText();
    expect(text).toContain('The session that wrote it has ended');
    expect(text).toContain('Branch: feat/x, compared with main');
    expect(text).toContain('a.txt (+1 -1)');
    expect(text).toContain('b.txt (+1 -0)');
    expect(text).toContain('W-1 "Shout less" (In progress)');
    expect(text).toContain('Make a.txt calmer.');
    expect(text).toContain('I changed a.txt and added b.txt.');
    expect(text).toContain('On a.txt:2');
    expect(text).toContain('Lower case?');

    const item = readWork(workspaceId);
    if (!item.ok) throw new Error('expected work');
    expect(item.file.items[0].sessions).toEqual(['test-session-1', 'new-session-1']);
    expect(announceWork).toHaveBeenCalledWith(workspaceId);

    // The new session owns the review now: Request changes goes to it, and its resubmission updates this review.
    const one = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data;
    expect(one.sessionLive).toBe(true);
    const again = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: { 'x-codeman-parent-session': 'new-session-1' },
      payload: { title: 'Work', walkthrough: 'Lower-cased it.' },
    });
    expect(again.json().data).toMatchObject({ id, revision: 2 });
  });

  it('closes the new session and changes nothing when the prompt never reached it', async () => {
    const { id } = await ended();
    vi.mocked(deliver).mockResolvedValue('not-ready');
    const res = await handOver(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('NOT_READY');
    expect(discardSession).toHaveBeenCalledWith(expect.anything(), 'new-session-1');
    const one = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data;
    expect(one.review).toMatchObject({ sessionId: 'test-session-1', unsent: 1 });
  });

  it('refuses when the folder no longer has the branch checked out', async () => {
    const { id } = await ended();
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    try {
      const res = await handOver(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('NOT_CHECKED_OUT');
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      execFileSync('git', ['checkout', '-q', 'feat/x'], { cwd: repo });
    }
  });

  /** The text the hand-over pasted: `deliver` is mocked, so the paste its deps would make is made here. */
  async function deliveredText(): Promise<string> {
    const writes: string[] = [];
    const fresh = harness.ctx.sessions.get('new-session-1') as unknown as { writeViaMux: unknown };
    fresh.writeViaMux = async (t: string) => {
      writes.push(t);
      return true;
    };
    const deps = vi.mocked(deliver).mock.calls[0][0] as unknown as { paste(): Promise<boolean> };
    await deps.paste();
    return writes.join('');
  }
});
