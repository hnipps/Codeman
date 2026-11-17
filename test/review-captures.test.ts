/**
 * Stills on a review: the rules (`review-model.ts`), the files and routes (`review-store.ts`,
 * `review-routes.ts`), and what the agent's CLI reads before it sends anything (`cli-agent.ts`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentReviewSubmit,
  EXIT,
  loadReviewCaptures,
  parseCaptureSpec,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';
import { dataPath } from '../src/config/instance.js';
import { deployRole } from '../src/deploy-role.js';
import {
  addNote,
  decide,
  NoteAnchorSchema,
  putCapture,
  requestChangesPrompt,
  ReviewFileSchema,
  submitReview,
  type Capture,
  type Review,
} from '../src/reviews/review-model.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

const SHA = 'a'.repeat(40);
const facts = { repoRoot: '/repo', project: 'repo', branch: 'feat/x', base: 'main', headSha: SHA };
const author = { owner: null, sessionId: 'sess-1', sessionName: 'w4' };
const fresh = (): Review =>
  submitReview(undefined, { title: 'T', walkthrough: 'Hello' }, facts, author, 'aaaaaaaa', 1000);
const still = (name: string, ext: Capture['ext'] = '.png'): Capture => ({
  name,
  ext,
  width: 10,
  height: 20,
  bytes: 33,
  label: '',
  at: 2000,
});

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

describe('capture rules', () => {
  it('adds a still, replaces one of the same name, and keeps a review without stills valid', () => {
    expect(ReviewFileSchema.safeParse({ version: 1, review: fresh() }).success).toBe(true);
    const one = putCapture(fresh(), still('settings'));
    if (!one.ok) throw new Error('refused');
    const two = putCapture(one.review, { ...still('settings', '.jpg'), width: 99 });
    if (!two.ok) throw new Error('refused');
    expect(two.review.captures).toEqual([{ ...still('settings', '.jpg'), width: 99 }]);
    expect(ReviewFileSchema.safeParse({ version: 1, review: two.review }).success).toBe(true);
  });

  it('stops at the limit, and a decided review takes none', () => {
    let review = fresh();
    for (let i = 0; i < 24; i++) {
      const next = putCapture(review, still(`s${i}`));
      if (!next.ok) throw new Error('refused early');
      review = next.review;
    }
    expect(putCapture(review, still('one-more'))).toMatchObject({ ok: false, code: 'FULL' });
    expect(putCapture(review, still('s3')).ok).toBe(true);
    const merged = decide(fresh(), { kind: 'merged', at: 5, mergedSha: SHA });
    if (!merged.ok) throw new Error('refused');
    expect(putCapture(merged.review, still('late'))).toMatchObject({ ok: false, code: 'DECIDED' });
  });

  it('a resubmission keeps every still unless it names the ones to keep', () => {
    const a = putCapture(fresh(), still('a'));
    const b = a.ok ? putCapture(a.review, still('b')) : a;
    if (!b.ok) throw new Error('refused');
    const input = { title: 'T', walkthrough: 'again' };
    expect(submitReview(b.review, input, facts, author, 'x', 3000).captures?.map((c) => c.name)).toEqual(['a', 'b']);
    expect(
      submitReview(b.review, { ...input, captures: ['b', 'new'] }, facts, author, 'x', 3000).captures?.map(
        (c) => c.name
      )
    ).toEqual(['b']);
    expect(submitReview(b.review, { ...input, captures: [] }, facts, author, 'x', 3000).captures).toBeUndefined();
  });

  it('a note on a still names the still and the point in the prompt', () => {
    const noted = addNote(
      fresh(),
      { at: { kind: 'capture', name: 'settings', x: 0.25, y: 0.5 }, text: 'too tight' },
      'bbbbbbbb',
      1100
    );
    if (!noted.ok) throw new Error('refused');
    const prompt = requestChangesPrompt(noted.review, noted.review.notes);
    expect('text' in prompt && prompt.text).toContain('On the capture "settings", at 25% across and 50% down');
    expect(NoteAnchorSchema.safeParse({ kind: 'capture', name: 'settings' }).success).toBe(true);
    for (const bad of [{ name: '../x' }, { name: 'settings', x: 1.2, y: 0 }, { name: 'settings', path: '/etc' }])
      expect(NoteAnchorSchema.safeParse({ kind: 'capture', ...bad }).success).toBe(false);
  });
});

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-captures-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  git('checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'second');
  return dir;
}

describe('capture routes', () => {
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
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  const submit = (captures?: string[]) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'See [it](#capture=settings)', ...(captures ? { captures } : {}) },
    });
  const put = (id: string, name: string, body: Buffer, headers: Record<string, string> = AGENT, type = 'image/png') =>
    harness.app.inject({
      method: 'PUT',
      url: `/api/reviews/${id}/captures/${name}`,
      headers: { ...headers, 'content-type': type },
      payload: body,
    });
  const files = (id: string) =>
    existsSync(dataPath('reviews', `${id}.captures`)) ? readdirSync(dataPath('reviews', `${id}.captures`)) : [];

  it('stores a still from the authoring session and serves it to a reader', async () => {
    const id = (await submit()).json().data.id as string;
    const stored = await harness.app.inject({
      method: 'PUT',
      url: `/api/reviews/${id}/captures/settings?label=Settings%20page`,
      headers: { ...AGENT, 'content-type': 'image/png' },
      payload: png(1440, 900),
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().data).toEqual({ name: 'settings', width: 1440, height: 900 });
    const view = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review;
    expect(view.captures).toMatchObject([
      { name: 'settings', ext: '.png', width: 1440, height: 900, label: 'Settings page' },
    ]);
    const got = await harness.app.inject({ url: `/api/reviews/${id}/captures/settings` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.rawPayload.equals(png(1440, 900))).toBe(true);
    expect((await harness.app.inject({ url: `/api/reviews/${id}/captures/other` })).statusCode).toBe(404);
  });

  it('refuses a person, another session, a bad name and bytes that are not the image they claim', async () => {
    const id = (await submit()).json().data.id as string;
    expect((await put(id, 'settings', png(1, 1), {})).statusCode).toBe(403);
    harness.ctx.sessions.set('other-session-9', {
      ...harness.ctx.sessions.get('test-session-1')!,
      id: 'other-session-9',
    });
    expect((await put(id, 'settings', png(1, 1), { 'x-codeman-parent-session': 'other-session-9' })).statusCode).toBe(
      403
    );
    expect((await put(id, 'Bad_Name', png(1, 1))).statusCode).toBe(400);
    expect((await put(id, 'settings', Buffer.from('<svg onload=alert(1)>'.padEnd(40)))).statusCode).toBe(400);
    expect((await put(id, 'settings', png(1, 1), AGENT, 'image/jpeg')).statusCode).toBe(400);
    expect((await put(id, 'settings', png(1, 1), AGENT, 'image/svg+xml')).statusCode).toBe(415);
    expect((await put(id, 'settings', Buffer.alloc(3 * 1024 * 1024 + 2048), AGENT)).statusCode).toBe(413);
    expect(files(id)).toEqual([]);
    expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.review.captures).toBeUndefined();
  });

  it('serves only the file the record names, and never a symlink', async () => {
    const id = (await submit()).json().data.id as string;
    await put(id, 'settings', png(2, 2));
    writeFileSync(dataPath('reviews', `${id}.captures`, 'stray.png'), png(3, 3));
    expect((await harness.app.inject({ url: `/api/reviews/${id}/captures/stray` })).statusCode).toBe(404);
    expect((await harness.app.inject({ url: `/api/reviews/${id}/captures/..%2F${id}` })).statusCode).toBe(404);
    rmSync(dataPath('reviews', `${id}.captures`, 'settings.png'));
    symlinkSync(dataPath('reviews', `${id}.json`), dataPath('reviews', `${id}.captures`, 'settings.png'));
    expect((await harness.app.inject({ url: `/api/reviews/${id}/captures/settings` })).statusCode).toBe(404);
  });

  it('a resubmission that names its stills drops the others and their files', async () => {
    const id = (await submit()).json().data.id as string;
    await put(id, 'settings', png(2, 2));
    await put(id, 'queue', png(2, 2));
    await submit();
    expect(files(id).sort()).toEqual(['queue.png', 'settings.png']);
    await submit(['queue']);
    expect(files(id)).toEqual(['queue.png']);
    await submit([]);
    expect(existsSync(dataPath('reviews', `${id}.captures`))).toBe(false);
  });

  it('writes nothing on a colour that is not live', async () => {
    const id = (await submit()).json().data.id as string;
    vi.spyOn(deployRole, 'allows').mockReturnValue(false);
    expect((await put(id, 'settings', png(2, 2))).statusCode).toBe(409);
    expect(files(id)).toEqual([]);
  });
});

describe('what the CLI reads before it submits', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-capture-files-'));
    writeFileSync(join(dir, 'a.png'), png(4, 4));
    writeFileSync(join(dir, 'b.JPG'), png(4, 4));
    writeFileSync(join(dir, 'c.txt'), 'x');
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(3 * 1024 * 1024 + 1));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('parses name=path', () => {
    expect(parseCaptureSpec('settings=shots/a=b.png')).toEqual({ name: 'settings', path: 'shots/a=b.png' });
    for (const bad of ['settings', '=a.png', 'settings=']) expect(typeof parseCaptureSpec(bad)).toBe('string');
  });

  it('loads the stills, with the type the file name states', async () => {
    const got = await loadReviewCaptures([
      { name: 'a', path: join(dir, 'a.png'), label: 'First' },
      { name: 'b', path: join(dir, 'b.JPG') },
    ]);
    if (typeof got === 'string') throw new Error(got);
    expect(got.map((c) => [c.name, c.label, c.contentType, c.data.length])).toEqual([
      ['a', 'First', 'image/png', 33],
      ['b', '', 'image/jpeg', 33],
    ]);
  });

  const fakeDeps = (answer: (options: RequestOptions) => ApiResponse) => {
    const calls: RequestOptions[] = [];
    const err: string[] = [];
    const deps: AgentDeps = {
      ctx: { apiUrl: 'http://127.0.0.1:1', selfId: 'self-session-1' },
      json: true,
      io: { out: (l) => err.push(l), err: (l) => err.push(l) },
      request: async (_c, options) => {
        calls.push(options);
        return answer(options);
      },
    };
    return { deps, calls, err };
  };
  const answered = (data: unknown): ApiResponse => ({ status: 200, json: { success: true, data }, text: '' });
  const input = (captures: { name: string; path: string }[]) => ({ title: 'T', walkthrough: 'W', captures });

  it('submits the review naming its stills, then sends each one as bytes', async () => {
    const { deps, calls } = fakeDeps(() => answered({ id: 'abcdef0123456789', revision: 1, state: 'ready', url: 'x' }));
    const code = await agentReviewSubmit(deps, input([{ name: 'a', path: join(dir, 'a.png') }]));
    expect(code).toBe(EXIT.ok);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/api/v1/reviews'],
      ['PUT', '/api/v1/reviews/abcdef0123456789/captures/a'],
    ]);
    expect(calls[0].body).toEqual({ title: 'T', walkthrough: 'W', captures: ['a'] });
    expect(calls[1].rawBody?.contentType).toBe('image/png');
    expect(calls[1].rawBody?.data.equals(png(4, 4))).toBe(true);
  });

  it('sends nothing when a still cannot be read, and says so when the review went in and a still did not', async () => {
    const bad = fakeDeps(() => answered({}));
    expect(await agentReviewSubmit(bad.deps, input([{ name: 'gone', path: join(dir, 'gone.png') }]))).toBe(
      EXIT.refused
    );
    expect(bad.calls).toHaveLength(0);

    const half = fakeDeps((options) =>
      options.method === 'POST'
        ? answered({ id: 'abcdef0123456789', revision: 2, state: 'ready', url: 'x' })
        : { status: 409, json: { success: false, error: 'FULL: too many', errorCode: 'CONFLICT' }, text: '' }
    );
    expect(await agentReviewSubmit(half.deps, input([{ name: 'a', path: join(dir, 'a.png') }]))).not.toBe(EXIT.ok);
    expect(half.err.join(' ')).toContain('was submitted, but capture a was not stored');
  });

  it('a submit without stills names none, so the earlier ones stay', async () => {
    const { deps, calls } = fakeDeps(() => answered({ id: 'abcdef0123456789', revision: 2, state: 'ready', url: 'x' }));
    await agentReviewSubmit(deps, { title: 'T', walkthrough: 'W' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ title: 'T', walkthrough: 'W' });
  });

  it('refuses the whole set for one bad entry', async () => {
    const ok = { name: 'a', path: join(dir, 'a.png') };
    for (const bad of [
      { name: 'Bad', path: join(dir, 'a.png') },
      { name: 'a', path: join(dir, 'b.JPG') },
      { name: 'c', path: join(dir, 'c.txt') },
      { name: 'gone', path: join(dir, 'gone.png') },
      { name: 'big', path: join(dir, 'big.png') },
    ])
      expect(typeof (await loadReviewCaptures([ok, bad]))).toBe('string');
    expect(
      typeof (await loadReviewCaptures(Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, path: ok.path }))))
    ).toBe('string');
  });
});
