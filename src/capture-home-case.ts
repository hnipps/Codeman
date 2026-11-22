/**
 * @fileoverview Codeman's own case (ambient capture, intent/2026-11-19-ambient-capture.md, ticket 4).
 *
 * A capture made with no canvas workspace on screen and no shown session is filed in the canvas
 * workspace of the case that holds Codeman's own source (owner decision 2, 2026-11-19). This module
 * finds that case. It is read-only: it lists folders, probes them bounded and runs two git plumbing
 * commands that never run hooks, filters or a pager.
 *
 * The answer is the first case, in case-name order, whose folder is the MAIN checkout of a git
 * repository (its `.git` is a directory, so a linked worktree, whose `.git` is a file, never counts)
 * and:
 * - with a build id that is a commit sha (`CODEMAN_BUILD_ID`, this fork's deploys): whose repository
 *   holds that commit (`git cat-file -e <sha>^{commit}`);
 * - without one (an upstream install): whose folder is the git top level of the server's own
 *   install directory.
 *
 * Remote and Docker cases are skipped: git never runs on a folder a container can write (the git
 * status rule), and a name the remote or Docker registry holds is not a local folder. Every folder
 * is probed with `probePathKind()` first (#516), and each git call has a time limit.
 *
 * @dependency git-workspace-status.ts (runGit, isInsideAny), utils/bounded-path-probe
 */

import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isInsideAny, runGit, type GitRunner } from './git-workspace-status.js';
import { probePathKind, type PathProbeKind } from './utils/index.js';

/** How long one answer, found or not, is reused. */
export const HOME_CASE_CACHE_MS = 10 * 60 * 1000;
/** Time limit for each git call. A case on a stalled mount is skipped, not waited on. */
export const HOME_CASE_GIT_TIMEOUT_MS = 3_000;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

export type HomeCaseCandidate = { name: string; path: string };

export type HomeCaseDeps = {
  /** Local and linked cases the caller may see. Order does not matter; names are sorted here. */
  cases: () => Promise<HomeCaseCandidate[]>;
  /** Case names held by the remote or Docker registries. */
  foreignNames: () => Promise<string[]>;
  /** Host folders of Docker case workspaces. */
  dockerWorkspaces: () => Promise<string[]>;
  /** `CODEMAN_BUILD_ID`, raw. */
  buildId: string | undefined;
  /** The folder the server runs from; its git top level is the answer without a build id. */
  installDir: string;
  git?: GitRunner;
  probe?: (path: string) => Promise<PathProbeKind>;
};

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** The name of Codeman's own case, or null when no case qualifies. Never throws for a single bad case. */
export async function findHomeCase(deps: HomeCaseDeps): Promise<string | null> {
  const git = deps.git ?? runGit;
  const probe = deps.probe ?? ((p: string) => probePathKind(p));
  const timeoutMs = HOME_CASE_GIT_TIMEOUT_MS;
  const foreign = new Set(await deps.foreignNames().catch(() => []));
  const dockerRoots = await Promise.all((await deps.dockerWorkspaces().catch(() => [])).map(realOrSelf));
  const sha = deps.buildId && COMMIT_SHA.test(deps.buildId) ? deps.buildId : null;

  let installTop: string | null = null;
  if (!sha) {
    try {
      installTop = await realOrSelf(
        (await git(deps.installDir, ['rev-parse', '--show-toplevel'], { timeoutMs })).trim()
      );
    } catch {
      return null;
    }
    if (!installTop) return null;
  }

  const cases = (await deps.cases())
    .filter((c) => !foreign.has(c.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const c of cases) {
    if ((await probe(c.path)) !== 'directory') continue;
    if ((await probe(join(c.path, '.git'))) !== 'directory') continue;
    if (await isInsideAny(c.path, dockerRoots)) continue;
    try {
      if (sha) {
        await git(c.path, ['cat-file', '-e', `${sha}^{commit}`], { timeoutMs });
        return c.name;
      }
      const top = await realOrSelf((await git(c.path, ['rev-parse', '--show-toplevel'], { timeoutMs })).trim());
      if (top === installTop && top === (await realOrSelf(c.path))) return c.name;
    } catch {
      // Not this case: the commit is missing, git timed out, or the folder is not a repository.
    }
  }
  return null;
}

/** One cached answer for the whole server, found or not, for HOME_CASE_CACHE_MS. A lookup in flight is shared. */
export function createHomeCaseCache(
  find: () => Promise<string | null>,
  now: () => number = Date.now
): { get: () => Promise<string | null>; clear: () => void } {
  let cached: { at: number; name: string | null } | null = null;
  let inFlight: Promise<string | null> | null = null;
  return {
    get() {
      if (cached && now() - cached.at < HOME_CASE_CACHE_MS) return Promise.resolve(cached.name);
      inFlight ??= find()
        .then((name) => {
          cached = { at: now(), name };
          return name;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    clear() {
      cached = null;
    },
  };
}
