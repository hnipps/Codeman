/**
 * The pr-swarm tip watcher (`src/reviews/swarm-watcher.ts`) over a fake git reader, feeding the real run model
 * (`applySwarmEvent`) the way the runner's `tipMoved` does: what a moved tip queues or joins (I2, I8), which reviews
 * are read, the bounds, and rule 6. The real reader runs against real repositories at the end.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeReview, submitReview, type Review } from '../src/reviews/review-model.js';
import { watchTipReader } from '../src/reviews/swarm-git.js';
import {
  activeRun,
  applySwarmEvent,
  emptySwarmFile,
  SWARM_TRAILER,
  type SwarmFile,
  type SwarmRun,
  type TipChange,
} from '../src/reviews/swarm-model.js';
import type { SwarmTipResult } from '../src/reviews/swarm-runner.js';
import { createSwarmWatcher, type TipReader } from '../src/reviews/swarm-watcher.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const PERSON = { message: 'feat: more work\n\nSigned-off-by: someone' };
const OWN = { message: `fix: a finding\n\n${SWARM_TRAILER}` };

let idSeq = 0;
const review = (id: string, headSha = A, extra: Partial<Review> = {}): Review => ({
  ...submitReview(
    undefined,
    { title: `Review ${id}`, walkthrough: 'W' },
    { repoRoot: `/repo/${id}`, project: 'repo', branch: `feat/${id}`, base: 'main', headSha },
    { owner: null, sessionId: `session-${id}`, sessionName: 'w1' },
    id,
    1000
  ),
  ...extra,
});
const running = (roundTip = A): SwarmRun => ({
  id: 'run00000001',
  trigger: 'submit',
  requestedAt: 1,
  state: 'running',
  sessionId: 'swarm-session',
  startedAt: 2,
  round: 1,
  roundTip,
});

/** The watcher over in-memory run files, fed the way the runner applies a `tip` event. */
function setup(opts: { reviews: Review[]; tips: Record<string, string | null>; files?: Record<string, SwarmFile> }) {
  const files = new Map<string, SwarmFile>(opts.reviews.map((r) => [r.id, opts.files?.[r.id] ?? emptySwarmFile(r.id)]));
  const fed: { id: string; tip: string; change: TipChange }[] = [];
  const reader = {
    tip: vi.fn<TipReader['tip']>(async (r) => opts.tips[r.id] ?? null),
    commits: vi.fn<TipReader['commits']>(async () => [PERSON]),
  };
  const deps = {
    mayAct: vi.fn(() => true),
    reviews: () => opts.reviews,
    runs: (id: string) => files.get(id) ?? null,
    refusal: vi.fn(async (_r: Review): Promise<string | null> => null),
    reader,
    feed: vi.fn(async (id: string, tip: string, change: TipChange): Promise<SwarmTipResult> => {
      fed.push({ id, tip, change });
      const step = applySwarmEvent(
        files.get(id)!,
        { type: 'tip', tip, change, newRunId: `run${++idSeq}`.padEnd(11, '0') },
        5
      );
      files.set(id, step.file);
      return { ok: true, run: activeRun(step.file) ?? null };
    }),
    log: vi.fn(),
    readTimeoutMs: 10_000,
  };
  return { watcher: createSwarmWatcher(deps), deps, reader, files, fed };
}

describe('the tip watcher', () => {
  it('does nothing while the tip is the one the review was submitted at', async () => {
    const t = setup({ reviews: [review('r1')], tips: { r1: A } });
    await t.watcher.pass();
    await t.watcher.pass();
    expect(t.fed).toEqual([]);
    expect(t.files.get('r1')!.runs).toEqual([]);
  });

  it('a person’s push queues one run for the new tip, and the next pass leaves it alone', async () => {
    const t = setup({ reviews: [review('r1')], tips: { r1: B } });
    await t.watcher.pass();
    expect(t.fed).toEqual([{ id: 'r1', tip: B, change: 'change' }]);
    expect(t.files.get('r1')!.runs).toMatchObject([{ state: 'queued', trigger: 'push', tip: B }]);
    await t.watcher.pass();
    expect(t.fed).toHaveLength(1);
  });

  it('a push during a run joins it: the tip is recorded on the run and no second run appears (I2)', async () => {
    const t = setup({
      reviews: [review('r1')],
      tips: { r1: B },
      files: { r1: { ...emptySwarmFile('r1'), runs: [running(A)] } },
    });
    await t.watcher.pass();
    expect(t.reader.commits).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), A, B, expect.any(Number));
    expect(t.fed).toEqual([{ id: 'r1', tip: B, change: 'change' }]);
    expect(t.files.get('r1')!.runs).toEqual([{ ...running(A), pendingTip: B }]);
  });

  it('the run’s own trailer commits join the run and queue nothing, during it or after it (I8)', async () => {
    const t = setup({
      reviews: [review('r1')],
      tips: { r1: B },
      files: { r1: { ...emptySwarmFile('r1'), runs: [running(A)] } },
    });
    t.reader.commits.mockResolvedValue([OWN, OWN]);
    await t.watcher.pass();
    expect(t.fed).toEqual([{ id: 'r1', tip: B, change: 'own' }]);
    expect(t.files.get('r1')!.runs).toEqual([{ ...running(A), pendingTip: B }]);

    // The run pushed a fix and reviewed it before the watcher saw it move. Neither this watcher (last read A) nor a
    // fresh one (a restart) starts a run for it.
    const passed: SwarmRun = {
      id: 'run00000001',
      trigger: 'submit',
      requestedAt: 1,
      sessionId: 'swarm-session',
      startedAt: 2,
      endedAt: 3,
      rounds: 1,
      state: 'passed',
      reviewedTip: C,
      result: { verdict: 'APPROVE', findings: [], degradations: [] },
    };
    const tips: Record<string, string | null> = { r1: A };
    const after = setup({
      reviews: [review('r1')],
      tips,
      files: { r1: { ...emptySwarmFile('r1'), runs: [running(A)] } },
    });
    await after.watcher.pass();
    after.files.set('r1', { ...emptySwarmFile('r1'), runs: [passed] });
    tips.r1 = C;
    await after.watcher.pass();
    const fresh = setup({ reviews: [review('r1')], tips, files: { r1: { ...emptySwarmFile('r1'), runs: [passed] } } });
    await fresh.watcher.pass();
    expect([...after.fed, ...fresh.fed]).toEqual([]);
    expect(after.files.get('r1')!.runs).toEqual([passed]);
    expect(fresh.files.get('r1')!.runs).toEqual([passed]);
  });

  it('a mixed push during a run is a change, and a list that cannot be read is too', async () => {
    const t = setup({
      reviews: [review('r1')],
      tips: { r1: B },
      files: { r1: { ...emptySwarmFile('r1'), runs: [running(A)] } },
    });
    t.reader.commits.mockResolvedValueOnce([OWN, PERSON]);
    await t.watcher.pass();
    expect(t.fed.at(-1)?.change).toBe('change');
    const u = setup({
      reviews: [review('r1')],
      tips: { r1: B },
      files: { r1: { ...emptySwarmFile('r1'), runs: [running(A)] } },
    });
    u.reader.commits.mockResolvedValueOnce(null);
    await u.watcher.pass();
    expect(u.fed.at(-1)?.change).toBe('change');
  });

  it('reads the tips of open reviews only', async () => {
    const closed = closeReview(review('r2'), 2);
    if (!closed.ok) throw new Error('not closed');
    const decided = closed.review;
    const t = setup({ reviews: [review('r1'), decided], tips: { r1: B, r2: C } });
    await t.watcher.pass();
    expect(t.reader.tip.mock.calls.map(([r]) => r.id)).toEqual(['r1']);
    expect(t.fed.map((f) => f.id)).toEqual(['r1']);
  });

  it('reads at most two branches at a time', async () => {
    const reviews = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => review(id));
    const t = setup({ reviews, tips: {} });
    let inFlight = 0;
    let most = 0;
    t.reader.tip.mockImplementation(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return A;
    });
    await t.watcher.pass();
    expect(t.reader.tip).toHaveBeenCalledTimes(5);
    expect(most).toBe(2);
  });

  it('a read that hangs is given up, and the other reviews are still read', async () => {
    const t = setup({ reviews: [review('r1'), review('r2')], tips: { r2: B } });
    const watcher = createSwarmWatcher({ ...t.deps, readTimeoutMs: 10, giveUpMs: 30 });
    t.reader.tip.mockImplementation(async (r, deadline) => {
      expect(deadline).toBeGreaterThan(Date.now() - 1000);
      return r.id === 'r1' ? new Promise<string | null>(() => undefined) : B;
    });
    await watcher.pass();
    expect(t.fed).toEqual([{ id: 'r2', tip: B, change: 'change' }]);
    // A read that failed (the reader's own timeout kill) reads as null: nothing is fed.
    const u = setup({ reviews: [review('r1')], tips: { r1: null } });
    await u.watcher.pass();
    expect(u.fed).toEqual([]);
  });

  it('a remote or Docker review is never read, and the reason is kept for the page', async () => {
    const t = setup({ reviews: [review('r1'), review('r2')], tips: { r1: B, r2: B } });
    t.deps.refusal.mockImplementation(async (r) => (r.id === 'r1' ? 'A Docker session cannot be reviewed here' : null));
    await t.watcher.pass();
    expect(t.reader.tip.mock.calls.map(([r]) => r.id)).toEqual(['r2']);
    expect(t.fed.map((f) => f.id)).toEqual(['r2']);
    expect(t.watcher.refusalOf('r1')).toBe('A Docker session cannot be reviewed here');
    expect(t.watcher.refusalOf('r2')).toBeNull();
  });

  it('rule 6: a colour that is not live reads nothing and starts nothing', async () => {
    const t = setup({ reviews: [review('r1')], tips: { r1: B } });
    t.deps.mayAct.mockReturnValue(false);
    await t.watcher.pass();
    expect(t.reader.tip).not.toHaveBeenCalled();
    expect(t.deps.refusal).not.toHaveBeenCalled();
    expect(t.fed).toEqual([]);
  });

  it('after stop, a pass reads nothing', async () => {
    const t = setup({ reviews: [review('r1')], tips: { r1: B } });
    t.watcher.stop();
    await t.watcher.pass();
    expect(t.reader.tip).not.toHaveBeenCalled();
  });
});

describe('the real tip reader', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const gitIn =
    (cwd: string) =>
    (...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (git: ReturnType<typeof gitIn>, ...message: string[]) => {
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      ...message.flatMap((m) => ['-m', m])
    );
    return git('rev-parse', 'HEAD');
  };
  const deadline = () => Date.now() + 10_000;
  const reviewOf = (repoRoot: string, branch: string, headSha: string, work = false): Review => ({
    ...review('rr', headSha),
    repoRoot,
    branch,
    ...(work ? { sessionId: 'work:ws1:7', sessionName: 'W-7' } : {}),
  });

  it('reads a branch with no origin from its local ref, and lists the commits of a move', async () => {
    const repo = temp('swarm-watch-local-');
    const git = gitIn(repo);
    git('init', '-q', '-b', 'main');
    const base = commit(git, 'base');
    git('checkout', '-q', '-b', 'feat/x');
    const own = commit(git, 'fix: a finding', SWARM_TRAILER);
    const person = commit(git, 'feat: by hand');
    const reader = watchTipReader();
    const r = reviewOf(repo, 'feat/x', base);
    expect(await reader.tip(r, deadline())).toBe(person);
    expect(await reader.commits(r, base, person, deadline())).toEqual([
      { message: 'feat: by hand\n' },
      { message: `fix: a finding\n\n${SWARM_TRAILER}\n` },
    ]);
    expect(await reader.commits(r, base, own, deadline())).toHaveLength(1);
    // A work review lives on origin only.
    expect(await reader.tip(reviewOf(repo, 'feat/x', base, true), deadline())).toBeNull();
  });

  it('reads origin’s tip with ls-remote, and fetches only to list commits it does not have', async () => {
    const origin = temp('swarm-watch-origin-');
    gitIn(origin)('init', '-q', '--bare', '-b', 'main');
    const author = temp('swarm-watch-author-');
    const a = gitIn(author);
    a('init', '-q', '-b', 'main');
    const base = commit(a, 'base');
    a('remote', 'add', 'origin', origin);
    a('push', '-q', 'origin', 'main');
    a('checkout', '-q', '-b', 'feat/y');
    commit(a, 'one');
    a('push', '-q', 'origin', 'feat/y');
    const repo = temp('swarm-watch-clone-');
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
    const pushed = commit(a, 'two');
    a('push', '-q', 'origin', 'feat/y');

    const reader = watchTipReader();
    const r = reviewOf(repo, 'feat/y', base, true);
    expect(await reader.tip(r, deadline())).toBe(pushed);
    expect(() => gitIn(repo)('cat-file', '-e', `${pushed}^{commit}`)).toThrow();
    const listed = await reader.commits(r, base, pushed, deadline());
    expect(listed?.map((c) => c.message.trim())).toEqual(['two', 'one']);
    // A branch origin does not have: a work review reads nothing.
    expect(await reader.tip(reviewOf(repo, 'feat/none', base, true), deadline())).toBeNull();
    // A deadline already past reads nothing.
    expect(await reader.tip(r, Date.now() - 1)).toBeNull();
  });
});
