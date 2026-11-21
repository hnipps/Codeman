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
import { submitReview, type Review } from '../src/reviews/review-model.js';
import { prepareRun, readRunTip, removeRunWorktree, runWorktreeName } from '../src/reviews/swarm-git.js';

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
});
