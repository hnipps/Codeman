/**
 * The Reviews page's rendered Markdown: a changed `.md` file read as the branch tip has it (`reviewFileText`,
 * `GET /api/reviews/:id/file`), and notes anchored to words in it (`kind: 'doc'`), which travel with every other
 * note in the one Request changes prompt.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { MAX_REVIEW_DOC_BYTES, reviewFileText } from '../src/reviews/review-git.js';
import { NoteAnchorSchema, requestChangesPrompt, unsentNotes } from '../src/reviews/review-model.js';
import { readReview } from '../src/reviews/review-store.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

vi.mock('../src/canvas/conversation-delivery.js', async (original) => ({
  ...(await original<typeof import('../src/canvas/conversation-delivery.js')>()),
  deliver: vi.fn(async () => 'confirmed'),
}));
const { deliver } = await import('../src/canvas/conversation-delivery.js');

const PLAN = '# Plan\n\nWe ship the rendered view first.\n\n## Risks\n\nNone known.\n';

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-doc-')));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'gone.md'), '# Old\n');
  writeFileSync(join(dir, 'big.md'), 'x\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat/doc');
  writeFileSync(join(dir, 'plan.md'), PLAN);
  writeFileSync(join(dir, 'big.md'), 'y'.repeat(MAX_REVIEW_DOC_BYTES + 10));
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git('rm', '-q', 'gone.md');
  git('add', '.');
  git('commit', '-q', '-m', 'work');
  return dir;
}

const local = { from: 'local-first' as const, branch: 'feat/doc' };

describe('reading a changed Markdown file', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reads the file as the branch tip has it', async () => {
    const read = await reviewFileText(repo, 'main', local, { path: 'plan.md' });
    expect(read).toMatchObject({ kind: 'text', text: PLAN });
  });

  it('says a deleted file is absent and a large one too large, and reads nothing but Markdown', async () => {
    expect(await reviewFileText(repo, 'main', local, { path: 'gone.md' })).toEqual({ kind: 'absent' });
    expect(await reviewFileText(repo, 'main', local, { path: 'big.md' })).toMatchObject({ kind: 'too-large' });
    expect(await reviewFileText(repo, 'main', local, { path: 'a.txt' })).toBeNull();
    expect(await reviewFileText(repo, 'main', local, { path: '../plan.md' })).toBeNull();
    expect(await reviewFileText(repo, 'main', { ...local, branch: 'feat/missing' }, { path: 'plan.md' })).toBeNull();
  });

  it('accepts a doc anchor only with a repository path and words', () => {
    const anchor = { quote: 'rendered view', prefix: 'We ship the ', suffix: ' first.' };
    expect(NoteAnchorSchema.safeParse({ kind: 'doc', path: 'plan.md', anchor }).success).toBe(true);
    expect(NoteAnchorSchema.safeParse({ kind: 'doc', path: '/etc/plan.md', anchor }).success).toBe(false);
    expect(NoteAnchorSchema.safeParse({ kind: 'doc', path: 'plan.md' }).success).toBe(false);
  });
});

describe('rendered Markdown routes', () => {
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
  });
  afterEach(async () => {
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  const submit = async (): Promise<string> => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Plan', walkthrough: 'Read [the plan](#code=plan.md:1).' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.id as string;
  };
  const file = (id: string, path: string) =>
    harness.app.inject({ url: `/api/reviews/${id}/file?path=${encodeURIComponent(path)}` });

  it('serves a changed Markdown file, and refuses anything else', async () => {
    const id = await submit();
    const ok = await file(id, 'plan.md');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ path: 'plan.md', text: PLAN });
    expect(JSON.stringify(ok.json())).not.toContain(repo);

    expect((await file(id, 'a.txt')).statusCode).toBe(400);
    expect((await file(id, 'README.md')).statusCode).toBe(404);
    expect((await file(id, '../plan.md')).statusCode).toBe(404);
    const deleted = await file(id, 'gone.md');
    expect(deleted.statusCode).toBe(404);
    expect(deleted.json().error).toContain('deletes');
    const big = await file(id, 'big.md');
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toContain('too large');
  });

  it('a note on the rendered file is a note like any other: added by a person, sent in the one prompt', async () => {
    const id = await submit();
    const doc = {
      at: {
        kind: 'doc',
        path: 'plan.md',
        anchor: { quote: 'rendered view', prefix: 'We ship the ', suffix: ' first.' },
      },
      text: 'Ship the diff first instead.',
    };
    const byAgent = await harness.app.inject({
      method: 'POST',
      url: `/api/reviews/${id}/notes`,
      headers: AGENT,
      payload: doc,
    });
    expect(byAgent.statusCode).toBe(403);
    for (const payload of [doc, { at: { kind: 'general' }, text: 'Otherwise fine' }]) {
      const added = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/notes`, payload });
      expect(added.statusCode).toBe(200);
    }
    const stored = readReview(id);
    if (!stored.ok) throw new Error('expected the review on disk');
    const prompt = requestChangesPrompt(stored.review, unsentNotes(stored.review));
    if (!('text' in prompt)) throw new Error('expected a prompt');
    expect(prompt.text).toContain('1. On plan.md (the rendered document), at "rendered view"');
    expect(prompt.text).toContain('   Ship the diff first instead.');
    expect(prompt.text).toContain('2. General');

    const sent = await harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/request-changes`, payload: {} });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.sent).toHaveLength(2);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
