/**
 * What a pr-swarm run does in git (`src/reviews/swarm-git.ts`), against a REAL temporary repository: the tip of a
 * branch origin does not have, the detached worktree at that tip, which runs are review only (a spec review, a branch
 * checked out elsewhere), and removing the worktree again without force.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDetachedWorktree, resolveCaseRepository } from '../src/git-worktrees.js';
import { storedSource, submitReview, type Review } from '../src/reviews/review-model.js';
import {
  prepareRun,
  readR3Plan,
  readRunTip,
  removeRunSpec,
  removeRunWorktree,
  runWorktreeName,
  stageRunSpec,
} from '../src/reviews/swarm-git.js';

const ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo: string, path: string, text: string) => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), text);
  git(repo, 'add', '--', path);
  git(repo, 'commit', '-q', '-m', `edit ${path}`);
  return git(repo, 'rev-parse', 'HEAD');
};
const reviewOf = (repo: string, branch: string): Review =>
  submitReview(
    undefined,
    { title: 'T', walkthrough: 'W' },
    { repoRoot: repo, project: 'r', branch, base: 'master', headSha: git(repo, 'rev-parse', branch) },
    { owner: null, sessionId: 'author', sessionName: 'w1' },
    'aaaaaaaa',
    1
  );
const RUN = 'run00000001';
const workReview = (repo: string, branch: string, number: number, id: string): Review => ({
  ...reviewOf(repo, branch),
  ...storedSource({ kind: 'work', work: { workspaceId: 'ws1', number } }),
  id,
});
/** Merges `branch` into master with a real merge commit, as Approve does, and records it on the review. */
const merged = (repo: string, review: Review): Review => {
  git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${review.branch}`, review.branch);
  return { ...review, decision: { kind: 'merged', at: 1, mergedSha: git(repo, 'rev-parse', 'HEAD') } };
};

describe('swarm git', () => {
  let repo: string;
  let base: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-git-')));
    git(repo, 'init', '-q', '-b', 'master');
    base = commit(repo, 'README.md', 'hello\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('reads the local tip of a branch with no origin, and makes a detached worktree there that removes cleanly', async () => {
    git(repo, 'checkout', '-q', '-b', 'feat/x');
    const tipSha = commit(repo, 'src/a.ts', 'export const a = 1;\n');
    git(repo, 'checkout', '-q', 'master');
    const review = reviewOf(repo, 'feat/x');

    const tip = await readRunTip(review);
    expect(tip).toEqual({ sha: tipSha, remote: '.' });

    const prepared = await prepareRun(review, RUN, tip!, { dockerWorkspaces: [] });
    expect(prepared).toEqual({
      ok: true,
      plan: { workingDir: join(repo, '.claude', 'worktrees', runWorktreeName(RUN)), base, reviewOnly: null },
    });
    if (!prepared.ok) return;
    const wt = prepared.plan.workingDir;
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(tipSha);
    // Detached: no branch is made for the run, and feat/x is free for the triage to push to.
    expect(() => git(wt, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(git(repo, 'branch', '--list')).not.toContain('swarm-');

    expect(await removeRunWorktree(review, RUN, { dockerWorkspaces: [], isInUse: () => true })).toMatchObject({
      ok: false,
    });
    expect(existsSync(wt)).toBe(true);
    expect(await removeRunWorktree(review, RUN, { dockerWorkspaces: [], isInUse: () => false })).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(false);
    // Removing it again is not an error.
    expect(await removeRunWorktree(review, RUN, { dockerWorkspaces: [], isInUse: () => false })).toEqual({ ok: true });
  });

  it('makes a run review only when its branch with no origin is checked out', async () => {
    git(repo, 'checkout', '-q', '-b', 'feat/x');
    const tipSha = commit(repo, 'src/a.ts', 'export const a = 1;\n');
    const review = reviewOf(repo, 'feat/x');
    const prepared = await prepareRun(review, RUN, { sha: tipSha, remote: '.' }, { dockerWorkspaces: [] });
    expect(prepared.ok && prepared.plan.reviewOnly).toBe('checked-out');
  });

  it('makes a spec review, and only a spec review, review only', async () => {
    git(repo, 'checkout', '-q', '-b', 'spec/y');
    commit(repo, 'docs/proto.html', '<p>mock</p>\n');
    const specTip = commit(repo, 'intent/2026-11-21-y.md', '# Y\n\nSee docs/proto.html.\n');
    git(repo, 'checkout', '-q', 'master');
    const spec = await prepareRun(
      reviewOf(repo, 'spec/y'),
      RUN,
      { sha: specTip, remote: '.' },
      { dockerWorkspaces: [] }
    );
    expect(spec.ok && spec.plan.reviewOnly).toBe('spec');

    git(repo, 'checkout', '-q', '-b', 'work/z', 'master');
    commit(repo, 'intent/2026-11-21-z.md', '# Z\n');
    const workTip = commit(repo, 'src/z.ts', 'export const z = 1;\n');
    git(repo, 'checkout', '-q', 'master');
    const work = await prepareRun(
      reviewOf(repo, 'work/z'),
      'run00000002',
      { sha: workTip, remote: '.' },
      {
        dockerWorkspaces: [],
      }
    );
    expect(work.ok && work.plan.reviewOnly).toBeNull();
  });

  it('refuses a tip that is not a commit id, and a repository inside a Docker workspace', async () => {
    const review = reviewOf(repo, 'master');
    expect(await prepareRun(review, RUN, { sha: 'HEAD', remote: '.' }, { dockerWorkspaces: [] })).toMatchObject({
      ok: false,
    });
    expect(await prepareRun(review, RUN, { sha: base, remote: '.' }, { dockerWorkspaces: [repo] })).toMatchObject({
      ok: false,
    });
  });

  it('createDetachedWorktree refuses anything but a full commit id', async () => {
    const resolved = await resolveCaseRepository(repo, { dockerWorkspaces: [] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    for (const commitId of ['master', 'HEAD', base.slice(0, 12), `-${base.slice(1)}`]) {
      const made = await createDetachedWorktree(
        resolved.repo,
        { name: 'swarm-x', commit: commitId },
        { dockerWorkspaces: [] }
      );
      expect(made.ok).toBe(false);
    }
  });

  describe('readR3Plan (I9)', () => {
    const lookup = (parents: Review[], createdFrom: number | undefined = 108) => ({
      createdFrom: (): number | undefined => createdFrom,
      reviews: () => parents,
    });
    const noParent = (parents: Review[]) => ({
      createdFrom: (): number | undefined => undefined,
      reviews: () => parents,
    });
    let spec: Review;
    let work: Review;
    let workTip: string;
    beforeEach(() => {
      git(repo, 'checkout', '-q', '-b', 'spec/w108');
      commit(repo, 'intent/2026-11-20-x.md', '# X\n\nOutcome 1.\n');
      git(repo, 'checkout', '-q', 'master');
      spec = merged(repo, workReview(repo, 'spec/w108', 108, 'specspecspec01'));
      // The spec is later edited on master: R-3 still reads the version that was approved.
      commit(repo, 'intent/2026-11-20-x.md', '# X\n\nOutcome 1, edited.\n');
      git(repo, 'checkout', '-q', '-b', 'build/w131');
      workTip = commit(repo, 'src/w.ts', 'export const w = 1;\n');
      git(repo, 'checkout', '-q', 'master');
      work = workReview(repo, 'build/w131', 131, 'workworkwork01');
    });

    it('requires R-3 for work created from an item whose merged review was a spec review, with the spec as merged', async () => {
      expect(await readR3Plan(work, workTip, lookup([spec]))).toEqual({
        required: true,
        spec: { path: 'intent/2026-11-20-x.md', mergedSha: spec.decision!.mergedSha, text: '# X\n\nOutcome 1.\n' },
      });
    });

    it('does not require it for unattributed work, a session review, an unmerged parent or a parent that was not a spec', async () => {
      expect(await readR3Plan(work, workTip, noParent([spec]))).toEqual({ required: false });
      expect(await readR3Plan(work, workTip, lookup([spec], 99))).toEqual({ required: false });
      expect(await readR3Plan(reviewOf(repo, 'build/w131'), workTip, lookup([spec]))).toEqual({ required: false });
      const { decision: _, ...open } = spec;
      expect(await readR3Plan(work, workTip, lookup([open as Review]))).toEqual({ required: false });
      expect(await readR3Plan(work, workTip, lookup([{ ...spec, decision: { kind: 'closed', at: 1 } }]))).toEqual({
        required: false,
      });
      expect(await readR3Plan(work, workTip, lookup([{ ...spec, repoRoot: '/elsewhere' }]))).toEqual({
        required: false,
      });

      git(repo, 'checkout', '-q', '-b', 'build/w108-code');
      commit(repo, 'src/code.ts', 'export const c = 1;\n');
      git(repo, 'checkout', '-q', 'master');
      const code = merged(repo, workReview(repo, 'build/w108-code', 108, 'codecodecode01'));
      expect(await readR3Plan(work, workTip, lookup([code]))).toEqual({ required: false });
    });

    it('does not require it when the work review is itself a spec review', async () => {
      git(repo, 'checkout', '-q', '-b', 'spec/w131');
      const tip = commit(repo, 'intent/2026-11-21-y.md', '# Y\n');
      git(repo, 'checkout', '-q', 'master');
      expect(await readR3Plan(workReview(repo, 'spec/w131', 131, 'specspecspec02'), tip, lookup([spec]))).toEqual({
        required: false,
      });
    });

    it('requires it but gives no spec when the spec review changed more than one spec file', async () => {
      git(repo, 'checkout', '-q', '-b', 'spec/two');
      commit(repo, 'intent/2026-11-21-a.md', '# A\n');
      commit(repo, 'intent/2026-11-21-b.md', '# B\n');
      git(repo, 'checkout', '-q', 'master');
      const two = merged(repo, workReview(repo, 'spec/two', 108, 'twotwotwotwo01'));
      expect(await readR3Plan(work, workTip, lookup([two]))).toEqual({
        required: true,
        spec: null,
        missing: expect.stringContaining('changed 2 spec files'),
      });
    });

    it('stages the spec outside the worktree and removes it again', async () => {
      const dir = join(repo, '..', `${repo.split('/').pop()}-spec`);
      const file = await stageRunSpec(dir, RUN, { path: 'intent/x.md', mergedSha: base, text: '# X\n' });
      expect(file).toBe(join(dir, `${runWorktreeName(RUN)}.md`));
      expect(existsSync(file)).toBe(true);
      await removeRunSpec(dir, RUN);
      expect(existsSync(file)).toBe(false);
      await removeRunSpec(dir, RUN);
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
