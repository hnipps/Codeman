/**
 * @fileoverview The Reviews page: an agent's walkthrough of a finished branch, a person's notes on it, and the
 * request for changes (`src/reviews/`, `intent/2026-11-16-reviews-page.md`).
 *
 * Endpoints:
 *   GET    /api/reviews                          the queue: waiting, and decided in the last day
 *   POST   /api/reviews                          an AGENT submits or resubmits { title, walkthrough, base? }
 *   GET    /api/reviews/:id                      one review, with whether its author session still runs
 *   GET    /api/reviews/:id/changes              the files the branch changes against its base
 *   GET    /api/reviews/:id/diff?path=           one of those files' diff
 *   GET    /api/reviews/:id/file?path=           one changed Markdown file as the branch tip has it, to read rendered
 *   POST   /api/reviews/:id/notes                a PERSON adds a note { at, text }
 *   PATCH  /api/reviews/:id/notes/:noteId        a PERSON edits or resolves a note { text?, resolved? }
 *   DELETE /api/reviews/:id/notes/:noteId        a PERSON deletes an unsent note
 *   POST   /api/reviews/:id/request-changes      a PERSON sends every unsent note as ONE prompt
 *   POST   /api/reviews/:id/new-session          a PERSON hands the review, with its notes, to a NEW session once the
 *                                                author session has ended
 *   GET    /api/reviews/:id/swarm                the review's pr-swarm runs, whether this server drives them, and why
 *                                                the tip watcher could not read the branch
 *   POST   /api/reviews/:id/swarm                a PERSON starts a pr-swarm run at the branch tip (409 RUNNING: one
 *                                                is queued or running, and the answer carries it)
 *   POST   /api/reviews/:id/swarm/resend         a PERSON sends a finished run's findings again (not built yet: 501)
 *   POST   /api/reviews/swarm-runs/:runId/report the run's OWN session hands back its result (`codeman agent swarm
 *                                                report`)
 *
 * Who may do what:
 * - Submitting is the agent's act: the request must carry `X-Codeman-Parent-Session`, and the review is made for
 *   THAT session's checked-out branch. Nothing in the body names a repository or a session. When that branch is the
 *   pull request of an open Work item linked to the session, the walkthrough goes onto the item's work review instead
 *   (`WorkReviews.authorFor`).
 * - Notes, resolving and Request changes are a person's acts: a request that carries the agent header is refused.
 * - A review belongs to its author session's owner. Every read and write checks it, and a review another user
 *   owns answers 404, like a session does.
 * - Only the live deploy colour writes.
 * - Git never runs for a remote or Docker session, nor for a repository at or inside a Docker case workspace.
 *
 * A hand-over starts one Claude session in the review's checked-out folder through the ordinary create routes, with
 * the person's own credentials (`startSession`), and pastes one prompt carrying the whole review: title, walkthrough,
 * branch and base, the changed files, the open canvas Work items linked to the old session, and the notes. Only once
 * that paste reached the pane does the review move to the new session (its resubmissions then update the same review)
 * and the work items link it; a paste that never landed deletes the session again and changes nothing.
 *
 * pr-swarm runs start by themselves: a submit or resubmit triggers one after its answer has gone out, and the tip
 * watcher (`swarm-watcher.ts`) looks at every open review's branch on the runner's minute tick. Both reach the one
 * runner this function makes (or is given), so the one-run-at-a-time slot holds.
 *
 * The prompt is delivered the way a canvas conversation is (`deliver()`): a paste that never reached the pane
 * stamps nothing; one that was written is stamped even when Enter was not confirmed, since sending again would
 * paste it twice.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { imageSize } from '../../canvas/canvas-assets.js';
import { deliver } from '../../canvas/conversation-delivery.js';
import { SendLimiter } from '../../canvas/send-limit.js';
import { getDataDir } from '../../config/instance.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import {
  readOverview as realReadOverview,
  requestDeploy as realRequestDeploy,
  supervisorCli,
  type DeployOverviewConfigured,
} from '../../deploy-control.js';
import { deployRole } from '../../deploy-role.js';
import { isInsideAny, runGit } from '../../git-workspace-status.js';
import { isPathWithin } from '../../git-worktrees.js';
import {
  line,
  ReviewGitRefusal,
  repoFacts,
  reviewChanges,
  reviewFileDiff,
  reviewFileText,
  isReviewDoc,
  MAX_REVIEW_DOC_BYTES,
  SHA,
  tryGit,
  headOf,
  type ReviewChanges,
} from '../../reviews/review-git.js';
import {
  createLiveControl,
  LiveError,
  liveView,
  previewFor,
  type LiveControl,
  type LiveView,
} from '../../reviews/review-live.js';
import { mergeReviewedBranch, type MergeInput, type MergeResult } from '../../reviews/review-merge.js';
import {
  CaptureNameSchema,
  MAX_CAPTURE_BYTES,
  MAX_OPEN_REVIEWS,
  NoteBodySchema,
  NotePatchSchema,
  ReviewIdSchema,
  SubmitSchema,
  addNote,
  cleanLine,
  closeReview,
  decide,
  reopenReview,
  supersededCandidates,
  handOver,
  handoverPrompt,
  isDecided,
  isOpen,
  mayAddCaptures,
  patchNote,
  putCapture,
  queueOf,
  removeNote,
  requestChangesPrompt,
  sameWork,
  settledDeploy,
  stampSent,
  sourceOf,
  submitReview,
  authorSessionId,
  toView,
  unsentNotes,
  type Changed,
  type Decision,
  type Refusal,
  type Review,
} from '../../reviews/review-model.js';
import {
  changeReview,
  findCaptureFile,
  listReviews,
  newReviewId,
  pruneCaptureFiles,
  readReview,
  writeCaptureFile,
  writeReview,
} from '../../reviews/review-store.js';
import { closeSessionWork, handoverWork, linkSessionToWork, workItemsForSession } from '../../reviews/review-work.js';
import {
  prepareRun,
  readRunTip,
  removeRunWorktree,
  WATCH_READ_TIMEOUT_MS,
  watchTipReader,
} from '../../reviews/swarm-git.js';
import { createSwarmRunner, SWARM_TICK_MS, type SwarmRunner } from '../../reviews/swarm-runner.js';
import { readSwarm } from '../../reviews/swarm-store.js';
import { createSwarmWatcher } from '../../reviews/swarm-watcher.js';
import { createWorkReviews, type SyncResult, type WorkReviews } from '../../reviews/work-reviews.js';
import type { Session } from '../../session.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CleanupManager } from '../../utils/index.js';
import { webviewCapabilities } from '../../webview-capabilities.js';
import { readWebviews } from '../../webview-store.js';
import { approvalInbox } from '../approval-inbox.js';
import type { EventPort, SessionPort } from '../ports/index.js';
import { canAccessOwned, getAuthUser, isAdmin, parseBody } from '../route-helpers.js';
import { SwarmReportBodySchema, SwarmRunIdSchema, SwarmStartSchema } from '../schemas.js';
import { SseEvent } from '../sse-events.js';
import { proxyPrefixFor } from '../webview-proxy.js';
import { deliveryDeps } from './canvas-conversation-routes.js';
import { localFileSource, sendFileBody } from './file-routes.js';
import { resolveCasePath } from './case-routes.js';
import { defaultDockerWorkspaces } from './git-status-routes.js';
import { registryAgentSkillDirs } from './worktree-routes.js';
import { imageMagicMatchesExt } from './session-routes.js';

type Ctx = SessionPort & EventPort;
export interface ReviewRouteOptions {
  /** Host paths of Docker case workspaces. Injected by tests; rejects when the list cannot be read. */
  dockerWorkspaces?: () => Promise<string[]>;
  /** The reverse-proxy mount prefix, for the preview frame's address. */
  basePath?: string;
  /** The deploy supervisor, as `deploy-control.ts` reaches it. Injected by tests, which must never reach a real one. */
  deploy?: {
    cli: () => string | null;
    readOverview: (cli: string) => Promise<DeployOverviewConfigured>;
    requestDeploy: (cli: string, sha: string) => Promise<{ requestId: string }>;
  };
  /** The merge. Injected by tests that are about something else. */
  merge?: (input: MergeInput) => Promise<MergeResult>;
  /** The preview service behind Open live. Injected by tests, which must never reach a real one. */
  live?: LiveControl;
  /**
   * Starts one agent session through the ordinary create and start routes with the caller's credentials (the server's
   * `startConversationSession`). Absent, a review cannot be handed to a new session.
   */
  startSession?: (
    headers: Readonly<Record<string, string | string[] | undefined>>,
    request: { workingDir: string; name: string; mode: string; launch: Record<string, unknown> }
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
  /** Deletes a session `startSession` made, when the hand-over failed after it. */
  discardSession?: (
    headers: Readonly<Record<string, string | string[] | undefined>>,
    sessionId: string
  ) => Promise<void>;
  /** Reviews of work items' pull requests. Injected by tests; by default made here and follows item writes. */
  workReviews?: WorkReviews;
  /** Tells canvas pages that a workspace's items changed (Request changes and Approve of a work review write them). */
  announceWork?: (workspaceId: string) => void;
  /** The pr-swarm runner. Injected by tests; by default made here, over `startSession` and `swarmHeaders`. */
  swarm?: SwarmRunner;
  /**
   * The credentials a pr-swarm run's session is started and deleted with: the review owner's, as a server-made
   * request (`internalHeaders`). Null when the owner cannot be acted for; absent, no run can start a session.
   */
  swarmHeaders?: (owner: string | null) => Promise<Readonly<Record<string, string>> | null>;
  /** Whether the server's sessions are restored, so a run's session can be judged alive. Absent: always. */
  sessionsRestored?: () => boolean;
}

const LiveActionSchema = z.object({ action: z.enum(['build', 'open', 'close']) }).strict();
/** One build request per review at a time. */
const buildingLive = new Set<string>();

const ApproveSchema = z.object({ headSha: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
/** One merge per repository at a time. */
const merging = new Set<string>();
/** Whether a repository is the one this Codeman is built from, remembered briefly: the answer costs a supervisor call. */
const selfDeployCache = new Map<string, { at: number; value: boolean }>();
const SELF_DEPLOY_TTL_MS = 30_000;
const SETTLE_EVERY_MS = 3_000;
let settledAt = 0;

/** A work review's page read fetches its branch at most this often; the queue read never fetches. */
const WORK_FETCH_TTL_MS = 60_000;

const PreviewOpenSchema = z.object({ webviewId: z.string().min(1).max(200) }).strict();

const DiffQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const limiter = new SendLimiter();
/** One send per review at a time, so two presses cannot paste the same notes twice. */
const sending = new Set<string>();
/** The file lists of recent reads, so a diff request can check its path without running the listing again. */
const changesCache = new Map<string, { at: number; changes: ReviewChanges }>();
const CHANGES_TTL_MS = 5_000;
const CHANGES_CACHE_MAX = 50;

const CAPTURE_TYPES: Readonly<Record<string, '.png' | '.jpg' | '.webp'>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const CAPTURE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' } as const;
/** A decided review keeps its stills this long; after it only the walkthrough, notes and decision remain. */
const CAPTURES_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const CaptureQuerySchema = z.object({ label: z.string().max(200).optional() }).strict();

const PERSON_ONLY = 'A review is noted and decided by a person only';
const NOT_LIVE = 'Only the live colour may write reviews';

function agentHeader(req: FastifyRequest): string {
  const header = req.headers['x-codeman-parent-session'];
  const raw = Array.isArray(header) ? header[0] : header;
  return typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
}

/** The session an agent's request speaks for: an exact id, or a unique prefix of 8 or more, that the caller may see. */
function callerSession(ctx: Ctx, req: FastifyRequest): Session | undefined {
  const candidate = agentHeader(req);
  if (!candidate) return undefined;
  let found = ctx.sessions.get(candidate);
  if (!found && candidate.length >= 8) {
    for (const session of ctx.sessions.values()) {
      if (!session.id.startsWith(candidate)) continue;
      if (found) return undefined;
      found = session;
    }
  }
  return found && canAccessOwned(getAuthUser(req), found.owner) ? found : undefined;
}

export function registerReviewPageRoutes(app: FastifyInstance, ctx: Ctx, options: ReviewRouteOptions = {}): void {
  const dockerWorkspaces = options.dockerWorkspaces ?? defaultDockerWorkspaces;
  const fail = (reply: FastifyReply, status: number, code: ApiErrorCode, message: string) =>
    reply.code(status).send(createErrorResponse(code, message));
  const announce = (review: Review) =>
    ctx.broadcast(SseEvent.ReviewChanged, { id: review.id, owner: review.owner ?? '@single' });

  const visible = (req: FastifyRequest, review: Review): boolean =>
    canAccessOwned(getAuthUser(req), review.owner ?? undefined);

  /** The review a route was asked for, or a reply already sent. */
  const reviewOf = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Review | null => {
    const id = ReviewIdSchema.safeParse(req.params.id);
    const read = id.success ? readReview(id.data) : null;
    if (!read || !read.ok || !visible(req, read.review)) {
      void fail(
        reply,
        read && !read.ok && read.reason !== 'missing' ? 409 : 404,
        read && !read.ok && read.reason !== 'missing' ? ApiErrorCode.CONFLICT : ApiErrorCode.NOT_FOUND,
        read && !read.ok && read.reason === 'newer'
          ? 'This review was saved by a newer release'
          : read && !read.ok && read.reason === 'unreadable'
            ? 'The review file could not be read'
            : 'Review not found'
      );
      return null;
    }
    return read.review;
  };

  /** Refuses an agent caller and a colour that may not write. Returns false when it has replied. */
  const personMayWrite = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (agentHeader(req)) {
      void fail(reply, 403, ApiErrorCode.FORBIDDEN, PERSON_ONLY);
      return false;
    }
    if (!deployRole.allows('persist')) {
      void fail(reply, 409, ApiErrorCode.CONFLICT, NOT_LIVE);
      return false;
    }
    return true;
  };

  /** Why git must not run in this folder, or null. Fails closed when the Docker list cannot be read. */
  const gitRefusal = async (session: Session | undefined, repoRoot: string): Promise<string | null> => {
    if (session?.remote) return 'A remote (SSH) session cannot be reviewed here';
    if (session?.docker) return 'A Docker session cannot be reviewed here';
    let roots: string[];
    try {
      roots = await dockerWorkspaces();
    } catch {
      return 'The Docker case list could not be read, so no repository is inspected';
    }
    return (await isInsideAny(repoRoot, roots)) ? 'A repository inside a Docker case cannot be reviewed here' : null;
  };

  const deploy = options.deploy ?? {
    cli: supervisorCli,
    readOverview: realReadOverview,
    requestDeploy: realRequestDeploy,
  };
  const merge = options.merge ?? ((input: MergeInput) => mergeReviewedBranch(input));

  /**
   * True when approving a branch of this repository also deploys it: the deploy supervisor is configured and the
   * commit that is live now is a commit of this repository. Only Codeman's own repository holds that commit.
   */
  const deploysItself = async (repoRoot: string): Promise<boolean> => {
    const cli = deploy.cli();
    if (!cli) return false;
    const hit = selfDeployCache.get(repoRoot);
    if (hit && Date.now() - hit.at < SELF_DEPLOY_TTL_MS) return hit.value;
    let value = false;
    try {
      const live = (await deploy.readOverview(cli)).live?.sha ?? '';
      value = SHA.test(live) && (await tryGit(runGit, repoRoot, ['cat-file', '-e', `${live}^{commit}`])) !== null;
    } catch {
      value = false;
    }
    selfDeployCache.set(repoRoot, { at: Date.now(), value });
    if (selfDeployCache.size > CHANGES_CACHE_MAX) selfDeployCache.delete(selfDeployCache.keys().next().value as string);
    return value;
  };

  const live = options.live ?? createLiveControl();

  /** The live session that wrote a review; a work review has none. */
  const authorSession = (review: Review): Session | undefined => {
    const id = authorSessionId(review);
    return id ? ctx.sessions.get(id) : undefined;
  };
  const personAuthor = (req: FastifyRequest) => ({ kind: 'human' as const, userId: getAuthUser(req).username });

  const workReviews =
    options.workReviews ??
    createWorkReviews({
      // The case folder as its owner sees it, like the canvas resolves an agent's workspace.
      casePath: async (w) => resolveCasePath(w.caseName, w.owner ? { username: w.owner, role: 'user' } : undefined),
      dockerWorkspaces,
      announce,
      announceWork: options.announceWork,
    });
  if (!options.workReviews) {
    const stop = workReviews.follow();
    app.addHook('onReady', async () => {
      if (deployRole.allows('persist')) void workReviews.catchUp().catch(() => undefined);
    });
    app.addHook('onClose', async () => stop());
  }
  const fetchedAt = new Map<string, number>();
  /** Brings a work review in step with its item and origin; fetches at most once a minute per review. */
  const syncWork = async (review: Review, fresh: boolean): Promise<SyncResult | null> => {
    const source = sourceOf(review);
    if (source.kind !== 'work') return null;
    const fetch = fresh || Date.now() - (fetchedAt.get(review.id) ?? 0) >= WORK_FETCH_TTL_MS;
    if (fetch) {
      fetchedAt.delete(review.id);
      fetchedAt.set(review.id, Date.now());
      if (fetchedAt.size > CHANGES_CACHE_MAX) fetchedAt.delete(fetchedAt.keys().next().value as string);
    }
    const result = await workReviews.sync(source.work, { fetch });
    if ('review' in result && result.changed) changesCache.delete(review.id);
    return result;
  };

  /** True when this review can have a live preview: the service exists and the branch is a branch of Codeman. */
  const liveApplies = async (review: Review): Promise<boolean> =>
    live.available() && !review.decision && (await deploysItself(review.repoRoot));

  /** What the page is told about the review's live preview. A service that does not answer reads as unavailable. */
  const liveOf = async (review: Review): Promise<LiveView> => {
    if (!(await liveApplies(review))) return { available: false };
    try {
      return liveView(previewFor(await live.status(), review.headSha));
    } catch {
      return { available: false };
    }
  };

  /**
   * Keeps the preview service in step with a review, after the answer has gone out: the preview of a commit the
   * review no longer shows is destroyed, and `build` asks for one of the commit it shows now. Failures are left
   * for the page, which offers the build again.
   */
  const syncLive = (review: Review, goneSha: string | undefined, build: boolean): void => {
    if (!live.available()) return;
    void (async () => {
      if (!(await deploysItself(review.repoRoot))) return;
      const previews = await live.status();
      const gone = goneSha && goneSha !== review.headSha ? previewFor(previews, goneSha) : null;
      if (gone) await live.destroy(gone.id).catch(() => undefined);
      if (build && !previewFor(previews, review.headSha)) await live.create(review.headSha);
    })().catch(() => undefined);
  };

  /**
   * Reads how each deploy a review asked for ended. The colour that asked is stopped by a deploy that succeeds, so
   * the answer is read later, by whichever colour is live, from the supervisor's own record.
   */
  const settleDeploys = async (): Promise<void> => {
    if (Date.now() - settledAt < SETTLE_EVERY_MS || !deployRole.allows('persist')) return;
    settledAt = Date.now();
    const all = listReviews();
    const waiting = all.filter((r) => r.decision?.kind === 'deploying' || r.decision?.kind === 'deploy-failed');
    const cli = deploy.cli();
    if (!waiting.length || !cli) return;
    let overview: DeployOverviewConfigured;
    try {
      overview = await deploy.readOverview(cli);
    } catch {
      return;
    }
    const liveSha = overview.live?.sha;
    /**
     * A review's folder is often a worktree that was removed after the merge, so every repository a review names is
     * asked. A commit id is the same commit in any of them, so one that answers yes is enough.
     */
    const repos = [...new Set(all.map((r) => r.repoRoot))];
    const liveContains = async (review: Review, merge: string, live: string): Promise<boolean> => {
      for (const repo of [review.repoRoot, ...repos.filter((r) => r !== review.repoRoot)])
        if ((await tryGit(runGit, repo, ['merge-base', '--is-ancestor', merge, live])) !== null) return true;
      return false;
    };
    for (const review of waiting) {
      const merge = review.decision?.mergedSha;
      const liveHasMerge = !!merge && !!liveSha && SHA.test(liveSha) && (await liveContains(review, merge, liveSha));
      const next = review.decision ? settledDeploy(review.decision, overview, Date.now(), liveHasMerge) : null;
      if (!next) continue;
      const changed = changeReview(review.id, (r) => decide(r, next));
      if (changed.ok) announce(changed.review);
    }
  };

  const changesOf = async (review: Review): Promise<ReviewChanges> => {
    const hit = changesCache.get(review.id);
    if (hit && Date.now() - hit.at < CHANGES_TTL_MS) return hit.changes;
    const changes = await reviewChanges(review.repoRoot, review.base, headOf(review));
    changesCache.delete(review.id);
    changesCache.set(review.id, { at: Date.now(), changes });
    if (changesCache.size > CHANGES_CACHE_MAX) changesCache.delete(changesCache.keys().next().value as string);
    return changes;
  };

  app.get('/api/reviews', async (req) => {
    await settleDeploys();
    const mine = listReviews().filter((r) => visible(req, r));
    return { success: true, data: queueOf(mine, Date.now(), workReviews.facts(mine)) };
  });

  app.post('/api/reviews', async (req, reply) => {
    const session = callerSession(ctx, req);
    if (!session)
      return fail(reply, 403, ApiErrorCode.FORBIDDEN, 'A review is submitted by the session that did the work');
    if (!deployRole.allows('persist')) return fail(reply, 409, ApiErrorCode.CONFLICT, NOT_LIVE);
    const input = parseBody(SubmitSchema, req.body);
    const refusal = await gitRefusal(session, session.workingDir);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    let facts;
    try {
      facts = await repoFacts(session.workingDir, input.base);
    } catch (err) {
      if (err instanceof ReviewGitRefusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, err.message);
      throw err;
    }
    // The repository's top level can sit above the session's folder, so the Docker rule is checked there too.
    const rootRefusal = await gitRefusal(session, facts.repoRoot);
    if (rootRefusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, rootRefusal);

    const work = await workReviews.authorFor(
      { sessionId: session.id, sessionName: session.name ?? '', owner: session.owner },
      facts,
      input
    );
    if (work.kind === 'unlinked') return fail(reply, 403, ApiErrorCode.FORBIDDEN, work.message);
    if (work.kind === 'conflict') return fail(reply, 409, ApiErrorCode.CONFLICT, work.message);
    if (work.kind === 'written') {
      pruneCaptureFiles(work.review);
      changesCache.delete(work.review.id);
      announce(work.review);
      syncLive(work.review, work.goneSha, true);
      swarmOnSubmit(work.review);
      return reply.code(200).send({
        success: true,
        data: {
          id: work.review.id,
          revision: work.review.revision,
          state: toView(work.review).state,
          url: `reviews/${work.review.id}`,
        },
      });
    }

    // Read, decide and write with no await between them, so two submissions cannot both make a new review.
    const all = listReviews();
    const owner = session.owner ?? null;
    // Where two open reviews of the branch already exist (written before W-77), the caller's own one is the match,
    // else the most recently updated one (a tie goes to the higher id), so the choice does not hang on directory order.
    const same = all.filter((r) => isOpen(r) && sameWork(r, owner, facts));
    const newer = (r: Review, a: Review) => r.updatedAt > a.updatedAt || (r.updatedAt === a.updatedAt && r.id > a.id);
    const open =
      same.find((r) => r.sessionId === session.id) ??
      same.reduce<Review | undefined>((a, r) => (!a || newer(r, a) ? r : a), undefined);
    if (!open && all.filter((r) => isOpen(r) && r.owner === owner).length >= MAX_OPEN_REVIEWS)
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'FULL: too many reviews are waiting; decide some first');
    const review = submitReview(
      open,
      input,
      facts,
      { owner, sessionId: session.id, sessionName: session.name ?? '' },
      newReviewId(),
      Date.now()
    );
    writeReview(review);
    if (open) pruneCaptureFiles(review);
    // Stills are the one large thing a review holds, so the ones of long-decided reviews go when new work arrives.
    for (const old of all) {
      if (!old.captures?.length || !isDecided(old) || Date.now() - (old.decision?.at ?? 0) < CAPTURES_KEPT_MS) continue;
      const { captures: _gone, ...rest } = old;
      writeReview(rest);
      pruneCaptureFiles(rest);
    }
    changesCache.delete(review.id);
    announce(review);
    syncLive(review, open?.headSha, true);
    swarmOnSubmit(review);
    return reply.code(open ? 200 : 201).send({
      success: true,
      data: { id: review.id, revision: review.revision, state: toView(review).state, url: `reviews/${review.id}` },
    });
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (req, reply) => {
    await settleDeploys();
    const read = reviewOf(req, reply);
    if (!read) return reply;
    // A work review's tip lives on origin: reading the page is when a push is noticed. A sync that cannot run (offline,
    // a refused case) leaves the review as it was stored, and the page shows that.
    const synced = await syncWork(read, false);
    const review = synced && 'review' in synced && synced.review.id === read.id ? synced.review : read;
    const session = authorSession(review);
    return {
      success: true,
      data: {
        review: toView(review),
        ...(sourceOf(review).kind === 'work' ? { work: workReviews.facts([review]).get(review.id) ?? null } : {}),
        // What the Approve button will do, so the page can say so before it is pressed.
        approve: { deploys: review.decision?.kind === 'merged' ? false : await deploysItself(review.repoRoot) },
        live: await liveOf(review),
        sessionLive: !!session && canAccessOwned(getAuthUser(req), session.owner) && !session.paneExit,
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id/changes', async (req, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const refusal = await gitRefusal(authorSession(review), review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    const changes = await changesOf(review);
    return { success: true, data: { ...changes, moved: !changes.gone && changes.headSha !== review.headSha } };
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id/diff', async (req, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const { path } = parseBody(DiffQuerySchema, req.query);
    const refusal = await gitRefusal(authorSession(review), review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    // The path is a key into the branch's own file list, never a path the browser chose.
    const file = (await changesOf(review)).files.find((f) => f.path === path);
    if (!file) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'That file is not part of this review');
    const diff = await reviewFileDiff(review.repoRoot, review.base, headOf(review), file);
    if (!diff) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'The branch is gone');
    return { success: true, data: { path: file.path, origPath: file.origPath, ...diff } };
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id/file', async (req, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const { path } = parseBody(DiffQuerySchema, req.query);
    // Markdown only: the page renders it through the one sanitizer. Any other file stays a diff.
    if (!isReviewDoc(path))
      return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Only a Markdown file is shown rendered');
    const refusal = await gitRefusal(authorSession(review), review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    // The path is a key into the branch's own file list, never a path the browser chose.
    const file = (await changesOf(review)).files.find((f) => f.path === path);
    if (!file) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'That file is not part of this review');
    const read = await reviewFileText(review.repoRoot, review.base, headOf(review), file);
    if (!read) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'The branch is gone');
    if (read.kind === 'absent')
      return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'This branch deletes the file, so there is nothing to render');
    if (read.kind === 'too-large')
      return fail(
        reply,
        400,
        ApiErrorCode.INVALID_INPUT,
        `The file is too large to render (${Math.ceil(read.bytes / 1024)} KiB; the limit is ${MAX_REVIEW_DOC_BYTES / 1024} KiB)`
      );
    return { success: true, data: { path: file.path, text: read.text, headSha: read.headSha } };
  });

  const noteStatus = (code: string): [number, ApiErrorCode] =>
    code === 'NOT_FOUND' ? [404, ApiErrorCode.NOT_FOUND] : [409, ApiErrorCode.CONFLICT];

  /** Runs one note change on a review the caller may see, and answers with the review as it is now. */
  const changeNotes = (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    change: (review: Review) => Changed | Refusal
  ) => {
    if (!personMayWrite(req, reply)) return reply;
    if (!reviewOf(req, reply)) return reply;
    const result = changeReview(req.params.id, change);
    if (!result.ok) {
      const [status, code] = 'missing' in result && result.missing ? noteStatus('NOT_FOUND') : noteStatus(result.code);
      return fail(reply, status, code, result.message);
    }
    announce(result.review);
    return { success: true, data: { review: toView(result.review) } };
  };

  app.post<{ Params: { id: string } }>('/api/reviews/:id/notes', async (req, reply) => {
    const body = parseBody(NoteBodySchema, req.body);
    return changeNotes(req, reply, (r) => addNote(r, body, newReviewId(), Date.now()));
  });

  app.patch<{ Params: { id: string; noteId: string } }>('/api/reviews/:id/notes/:noteId', async (req, reply) => {
    const body = parseBody(NotePatchSchema, req.body);
    return changeNotes(req, reply, (r) => patchNote(r, req.params.noteId, body, Date.now()));
  });

  app.delete<{ Params: { id: string; noteId: string } }>('/api/reviews/:id/notes/:noteId', async (req, reply) =>
    changeNotes(req, reply, (r) => removeNote(r, req.params.noteId))
  );

  /** Asks the supervisor for a deploy of the merge and returns what the review should record. */
  const askForDeploy = async (mergedSha: string): Promise<Decision> => {
    const cli = deploy.cli();
    try {
      if (!cli) throw new Error('Deploy control is not configured on this install');
      const { requestId } = await deploy.requestDeploy(cli, mergedSha);
      return { kind: 'deploying', at: Date.now(), mergedSha, deployRequestId: requestId.slice(0, 100) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The deploy could not be requested';
      return { kind: 'deploy-failed', at: Date.now(), mergedSha, error: message.slice(0, 200) };
    }
  };

  /** Who may ask for a deploy, and from which colour. Returns false when it has replied. */
  const mayDeploy = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (isMultiUserMode() && !isAdmin(req)) {
      void fail(reply, 403, ApiErrorCode.FORBIDDEN, 'Only an admin can approve a change that deploys Codeman');
      return false;
    }
    if (!deployRole.allows('requestDeploy')) {
      void fail(reply, 409, ApiErrorCode.CONFLICT, 'A deploy can only be requested from the live colour');
      return false;
    }
    return true;
  };

  /**
   * Approve. Merges the branch into its base exactly as the reviewer was shown it (`headSha`), and for Codeman's own
   * repository asks the supervisor to deploy the merge. Nothing here runs without this request, and nothing in it
   * touches a working tree (`review-merge.ts`).
   */
  app.post<{ Params: { id: string } }>('/api/reviews/:id/approve', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const read = reviewOf(req, reply);
    if (!read) return reply;
    if (read.decision) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been approved');
    const { headSha } = parseBody(ApproveSchema, req.body);
    // A work review merges what origin has now: a push since the page was read answers MOVED from the merge.
    const synced = await syncWork(read, true);
    if (synced && 'problem' in synced) return fail(reply, 409, ApiErrorCode.CONFLICT, synced.message);
    if (synced && ('unwanted' in synced || synced.review.id !== read.id))
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'GONE: the work item no longer asks for this review');
    const review = synced ? synced.review : read;
    if (review.decision) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been approved');
    const refusal = await gitRefusal(authorSession(review), review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    const deploys = await deploysItself(review.repoRoot);
    if (deploys && !mayDeploy(req, reply)) return reply;
    if (merging.has(review.repoRoot))
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'BUSY: another merge is running in this repository');
    merging.add(review.repoRoot);
    let merged: MergeResult;
    try {
      merged = await merge({
        repoRoot: review.repoRoot,
        base: review.base,
        head: headOf(review),
        headSha,
        title: review.title,
      });
    } finally {
      merging.delete(review.repoRoot);
    }
    if (!merged.ok) return fail(reply, 409, ApiErrorCode.CONFLICT, merged.message);
    // The merge exists from here on. It is recorded before the deploy is asked for, so a deploy that cannot be
    // requested leaves a merged review with a failed deploy, never an unrecorded merge.
    const mergedSha = merged.mergedSha;
    const first = changeReview(review.id, (r) => decide(r, { kind: 'merged', at: Date.now(), mergedSha }));
    let latest = first.ok ? first.review : review;
    // Before any await: once the review reads decided, a second Approve is refused, so nothing would retry this.
    const authorId = authorSessionId(review);
    const linkedWork = authorId
      ? closeSessionWork(review.owner, authorId, review.id, mergedSha, personAuthor(req))
      : { closed: [], failed: [] };
    for (const workspaceId of new Set(linkedWork.closed.map((c) => c.workspaceId))) options.announceWork?.(workspaceId);
    for (const f of linkedWork.failed)
      console.warn(`[reviews] Approve of ${review.id} merged, but ${f.key} could not move to Done: ${f.reason}`);
    const closedOthers = await closeSuperseded(review, mergedSha);
    workReviews.accepted(latest, mergedSha, personAuthor(req));
    if (deploys) {
      const decision = await askForDeploy(mergedSha);
      const second = changeReview(review.id, (r) => decide(r, decision));
      if (second.ok) latest = second.review;
    }
    changesCache.delete(review.id);
    announce(latest);
    // A decided review has no preview: the one of the commit that was reviewed is destroyed.
    syncLive({ ...latest, headSha: mergedSha }, review.headSha, false);
    return {
      success: true,
      data: {
        review: toView(latest),
        merge: { pushed: merged.pushed, localMoved: merged.localMoved, already: merged.already },
        closedOthers,
        linkedWork: {
          authorSession: authorId ?? null,
          closed: linkedWork.closed.map((c) => c.key),
          failed: linkedWork.failed.map(({ key, reason }) => ({ key, reason })),
        },
      },
    };
  });

  /**
   * After a merge, closes the other open reviews of the same branch whose head the merge already holds: duplicates of
   * the work just approved (two sessions, or a resubmission that opened a second review). One with commits the merge
   * does not contain stays open. Each records the review that closed it. Returns the ids closed.
   */
  const closeSuperseded = async (approved: Review, mergedSha: string): Promise<string[]> => {
    const closed: string[] = [];
    for (const other of supersededCandidates(listReviews(), approved)) {
      const contained =
        SHA.test(other.headSha) &&
        (await tryGit(runGit, approved.repoRoot, ['merge-base', '--is-ancestor', other.headSha, mergedSha])) !== null;
      if (!contained) continue;
      const changed = changeReview(other.id, (r) => closeReview(r, Date.now(), approved.id));
      if (!changed.ok) continue;
      closed.push(other.id);
      changesCache.delete(other.id);
      announce(changed.review);
      syncLive({ ...changed.review, headSha: '' }, other.headSha, false);
    }
    return closed;
  };

  /**
   * Close without merging, for a duplicate or work nobody wants any more. Only a person closes, and only a review
   * nothing was decided on. The branch, the notes and a work item are left as they are; the review's live preview is
   * destroyed, as on Approve. If the branch is submitted again, `sameWork` finds no open review and a new one opens.
   */
  app.post<{ Params: { id: string } }>('/api/reviews/:id/close', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const changed = changeReview(review.id, (r) => closeReview(r, Date.now()));
    if (!changed.ok) return fail(reply, 409, ApiErrorCode.CONFLICT, changed.message);
    changesCache.delete(review.id);
    announce(changed.review);
    // No commit is the review's any more, so its preview, if there is one, is the one that goes.
    syncLive({ ...changed.review, headSha: '' }, review.headSha, false);
    return { success: true, data: { review: toView(changed.review) } };
  });

  /**
   * Reopen a closed review: it waits again with its notes. Refused while another review of the same branch in the
   * same repository is open, which would put the same work in the queue twice.
   */
  app.post<{ Params: { id: string } }>('/api/reviews/:id/reopen', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const all = listReviews();
    const twin = all.find(
      (r) => r.id !== review.id && isOpen(r) && r.repoRoot === review.repoRoot && r.branch === review.branch
    );
    if (twin)
      return fail(reply, 409, ApiErrorCode.CONFLICT, `OPEN: review ${twin.id} of ${review.branch} is already open`);
    if (all.filter((r) => isOpen(r) && r.owner === review.owner).length >= MAX_OPEN_REVIEWS)
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'FULL: too many reviews are waiting; decide some first');
    const changed = changeReview(review.id, (r) => reopenReview(r));
    if (!changed.ok) return fail(reply, 409, ApiErrorCode.CONFLICT, changed.message);
    changesCache.delete(review.id);
    announce(changed.review);
    return { success: true, data: { review: toView(changed.review) } };
  });

  /** Asks again for the deploy of a merge whose deploy failed. The merge is not made again. */
  app.post<{ Params: { id: string } }>('/api/reviews/:id/deploy', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const mergedSha = review.decision?.kind === 'deploy-failed' ? review.decision.mergedSha : undefined;
    if (!mergedSha)
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'NOTHING: this review has no failed deploy to try again');
    if (!mayDeploy(req, reply)) return reply;
    const decision = await askForDeploy(mergedSha);
    const changed = changeReview(review.id, (r) => decide(r, decision));
    if (!changed.ok) return fail(reply, 409, ApiErrorCode.CONFLICT, changed.message);
    announce(changed.review);
    return { success: true, data: { review: toView(changed.review) } };
  });

  /**
   * Open live, for a branch of Codeman itself. `open` says a person is looking at the review: the preview wakes and
   * its idle clock restarts. `close` says they left. `build` asks for a preview when there is none, or when its
   * build failed. Only a person asks, from the live colour; the preview's id never leaves the server.
   */
  app.post<{ Params: { id: string } }>('/api/reviews/:id/live', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    if (isMultiUserMode() && !isAdmin(req))
      return fail(reply, 403, ApiErrorCode.FORBIDDEN, 'Only an admin can run a live preview of Codeman');
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const { action } = parseBody(LiveActionSchema, req.body);
    if (!(await liveApplies(review)))
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'NO_LIVE: this review has no live preview');
    try {
      const preview = previewFor(await live.status(), review.headSha);
      if (action === 'build') {
        if (preview && preview.state !== 'build-failed') return { success: true, data: { live: liveView(preview) } };
        if (buildingLive.has(review.id))
          return fail(reply, 409, ApiErrorCode.CONFLICT, 'BUSY: a build was just asked for');
        buildingLive.add(review.id);
        try {
          if (preview) await live.destroy(preview.id);
          await live.create(review.headSha);
        } finally {
          buildingLive.delete(review.id);
        }
      } else if (!preview || preview.state === 'building' || preview.state === 'build-failed') {
        // Nothing to wake or put to sleep yet. `close` is still a success: the page says it on its way out.
        if (action === 'open')
          return fail(reply, 409, ApiErrorCode.CONFLICT, 'NOT_READY: the live preview is not built yet');
      } else if (action === 'open') {
        await live.use(preview.id);
      } else {
        await live.release(preview.id);
      }
      return { success: true, data: { live: liveView(previewFor(await live.status(), review.headSha)) } };
    } catch (err) {
      if (!(err instanceof LiveError)) throw err;
      return fail(reply, err.code === 1 ? 409 : 502, ApiErrorCode.CONFLICT, err.message);
    }
  });

  /**
   * The address of the review's preview frame. It is the session's own preview, through a capability of its own that
   * makes the proxy inject the frame bridge, so a note can be put on an element of the page. The frame stays
   * sandboxed with an opaque origin; the bridge is its only channel to this page.
   */
  app.post<{ Params: { id: string } }>('/api/reviews/:id/preview', async (req, reply) => {
    if (agentHeader(req)) return fail(reply, 403, ApiErrorCode.FORBIDDEN, PERSON_ONLY);
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const body = parseBody(PreviewOpenSchema, req.body);
    const webview = (await readWebviews(getDataDir())).find((w) => w.id === body.webviewId);
    if (
      !webview ||
      webview.origin.kind !== 'session' ||
      webview.origin.sessionId !== authorSessionId(review) ||
      webview.embedMode === 'direct' ||
      !canAccessOwned(getAuthUser(req), webview.owner)
    )
      return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'That is not a preview of the session that wrote this review');
    const capability = webviewCapabilities.mint(webview.id, webview.owner, { bridge: true });
    return { success: true, data: { embedUrl: proxyPrefixFor(capability, options.basePath ?? '') } };
  });

  // Stills of the running branch. Only the session that wrote the review adds one; anyone who may read the review
  // may see one. The bytes are judged before they are written, and a file is served only by the name the review's
  // own record gives it, so no request carries a path.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      Object.keys(CAPTURE_TYPES),
      { parseAs: 'buffer', bodyLimit: MAX_CAPTURE_BYTES + 1024 },
      (_req, body, done) => done(null, body)
    );
    scope.put<{ Params: { id: string; name: string } }>(
      '/api/reviews/:id/captures/:name',
      { bodyLimit: MAX_CAPTURE_BYTES + 1024 },
      async (req, reply) => {
        const session = callerSession(ctx, req);
        const review = reviewOf(req, reply);
        if (!review) return reply;
        if (!session || !mayAddCaptures(review, session.id))
          return fail(
            reply,
            403,
            ApiErrorCode.FORBIDDEN,
            'Only the session that wrote a review, or the walkthrough of a work review, adds its captures'
          );
        if (!deployRole.allows('persist')) return fail(reply, 409, ApiErrorCode.CONFLICT, NOT_LIVE);
        const name = CaptureNameSchema.safeParse(req.params.name);
        if (!name.success)
          return fail(
            reply,
            400,
            ApiErrorCode.INVALID_INPUT,
            'A capture name is lowercase letters, digits and hyphens, at most 40 characters'
          );
        const { label } = parseBody(CaptureQuerySchema, req.query);
        const ext =
          CAPTURE_TYPES[
            String(req.headers['content-type'] ?? '')
              .split(';')[0]
              .trim()
              .toLowerCase()
          ];
        const data = req.body;
        if (!ext || !Buffer.isBuffer(data) || !data.length)
          return fail(reply, 415, ApiErrorCode.INVALID_INPUT, 'Send PNG, JPEG or WebP bytes with that Content-Type');
        if (data.length > MAX_CAPTURE_BYTES)
          return fail(reply, 413, ApiErrorCode.INVALID_INPUT, 'A capture is at most 3 MB');
        const size = imageMagicMatchesExt(data, ext) ? imageSize(data, ext) : null;
        if (!size || size.width > 20_000 || size.height > 20_000)
          return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'Those bytes are not the image their type says');
        const capture = {
          name: name.data,
          ext,
          ...size,
          bytes: data.length,
          label: cleanLine(label ?? '', 80),
          at: Date.now(),
        };
        // The record first: a refusal then leaves no file, and a file no record names is never served.
        const result = changeReview(review.id, (r) => putCapture(r, capture));
        if (!result.ok)
          return fail(
            reply,
            'missing' in result && result.missing ? 404 : 409,
            'missing' in result && result.missing ? ApiErrorCode.NOT_FOUND : ApiErrorCode.CONFLICT,
            result.message
          );
        writeCaptureFile(review.id, capture, data);
        // A still of the same name and another type left its file behind.
        pruneCaptureFiles(result.review);
        announce(result.review);
        return { success: true, data: { name: capture.name, width: capture.width, height: capture.height } };
      }
    );
  });

  app.get<{ Params: { id: string; name: string } }>('/api/reviews/:id/captures/:name', async (req, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const found = findCaptureFile(review, req.params.name);
    if (!found) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'Capture not found');
    reply
      .header('Content-Type', CAPTURE_MIME[found.capture.ext])
      // The page asks with `?v=<when it was taken>`, so a replaced still is a new address.
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff');
    sendFileBody(reply, found.size, req.headers.range, localFileSource(found.path));
    return reply;
  });

  /**
   * Request changes on a work review: the notes go on the item, which moves to the top of Ready for work, so the next
   * run on it reads them first, pushes to the same branch and reports. No pane is written and no agent is started here.
   */
  const sendToWork = (req: FastifyRequest, reply: FastifyReply, review: Review) => {
    const chosen = unsentNotes(review);
    const prompt = requestChangesPrompt(review, chosen);
    if ('refusal' in prompt) return fail(reply, 409, ApiErrorCode.CONFLICT, prompt.refusal);
    if (!limiter.take(review.id, false))
      return fail(reply, 429, ApiErrorCode.RATE_LIMITED, 'RATE_LIMITED: too many sends for this review; wait a moment');
    const sent = workReviews.sendChanges(review, prompt.text, personAuthor(req));
    if (!sent.ok) return fail(reply, 409, ApiErrorCode.CONFLICT, `NOT_WRITTEN: ${sent.message}; nothing was sent`);
    // The item has the notes. Stamp against the review as it is now.
    const ids = chosen.map((n) => n.id);
    const stamped = changeReview(review.id, (r) => ({ ok: true as const, review: stampSent(r, ids, Date.now()) }));
    if (stamped.ok) announce(stamped.review);
    return {
      success: true,
      data: {
        sent: stamped.ok ? ids : [],
        confirmed: true,
        review: toView(stamped.ok ? stamped.review : review),
        work: { key: sent.key, position: sent.position },
      },
    };
  };

  app.post<{ Params: { id: string } }>('/api/reviews/:id/request-changes', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    if (!isOpen(review)) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been decided');
    if (sourceOf(review).kind === 'work') return sendToWork(req, reply, review);
    const session = authorSession(review);
    if (!session || session.paneExit || !canAccessOwned(getAuthUser(req), session.owner))
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        'SESSION_ENDED: the session that wrote this review has ended; nothing was sent'
      );
    const pending = approvalInbox.getForSession(session.id);
    if (pending && pending.kind !== 'idle')
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        'APPROVAL_PENDING: answer the pending question in that session first'
      );
    const chosen = unsentNotes(review);
    const prompt = requestChangesPrompt(review, chosen);
    if ('refusal' in prompt) return fail(reply, 409, ApiErrorCode.CONFLICT, prompt.refusal);

    if (sending.has(review.id)) return fail(reply, 409, ApiErrorCode.CONFLICT, 'SENDING: these notes are being sent');
    if (!limiter.take(review.id, false))
      return fail(reply, 429, ApiErrorCode.RATE_LIMITED, 'RATE_LIMITED: too many sends for this review; wait a moment');
    sending.add(review.id);
    try {
      const result = await deliver(deliveryDeps(session, prompt.text), 'paste', Date.now());
      if (result === 'not-written' || result === 'not-ready')
        return fail(
          reply,
          409,
          ApiErrorCode.CONFLICT,
          result === 'not-ready'
            ? 'NOT_READY: the session was not ready for a prompt; nothing was sent'
            : 'NOT_WRITTEN: the prompt could not be written to the session; nothing was sent'
        );
      // The paste reached the pane. Stamp against the review as it is now: notes may have changed while it waited.
      const ids = chosen.map((n) => n.id);
      const stamped = changeReview(review.id, (r) => ({ ok: true as const, review: stampSent(r, ids, Date.now()) }));
      if (stamped.ok) announce(stamped.review);
      return {
        success: true,
        data: {
          sent: stamped.ok ? ids : [],
          confirmed: result === 'confirmed' || result === 'unverified',
          review: toView(stamped.ok ? stamped.review : review),
        },
      };
    } finally {
      sending.delete(review.id);
    }
  });

  app.post<{ Params: { id: string } }>('/api/reviews/:id/new-session', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    if (!isOpen(review)) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been decided');
    // A work review's notes go to its item (Request changes), never to a session.
    const authorId = authorSessionId(review);
    if (!authorId)
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        'WORK_REVIEW: a work item review takes notes through Request changes'
      );
    const old = authorSession(review);
    if (old && !old.paneExit && canAccessOwned(getAuthUser(req), old.owner))
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        'SESSION_LIVE: the session that wrote this review is still running; use Request changes'
      );
    const refusal = await gitRefusal(old, review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    // The new session starts in the review's folder, so that folder must still hold the branch.
    const checkedOut = line(
      (await tryGit(runGit, review.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? ''
    );
    if (!checkedOut)
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        `FOLDER_GONE: ${review.project} is no longer a git checkout on a branch; nothing was started`
      );
    if (checkedOut !== review.branch)
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        `NOT_CHECKED_OUT: ${review.project} has ${checkedOut} checked out, not ${review.branch}; check the branch out there first. Nothing was started`
      );
    let changes: ReviewChanges | null = null;
    try {
      changes = await changesOf(review);
    } catch {
      changes = null;
    }
    if (changes?.gone)
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        `BRANCH_GONE: ${review.branch} no longer exists; nothing was started`
      );
    const work = workItemsForSession(review.owner, authorId);
    const chosen = unsentNotes(review);
    const prompt = handoverPrompt(review, chosen, {
      files: (changes?.files ?? []).map((f) =>
        f.binary ? `${f.path} (binary)` : `${f.path} (+${f.added} -${f.deleted})`
      ),
      moreFiles: changes?.truncated ? 1 : 0,
      ...(changes ? { commits: changes.commits } : {}),
      work: work.map(handoverWork),
    });
    if ('refusal' in prompt) return fail(reply, 409, ApiErrorCode.CONFLICT, prompt.refusal);
    const start = options.startSession;
    if (!start)
      return fail(reply, 409, ApiErrorCode.CONFLICT, 'UNAVAILABLE: this server cannot start sessions for reviews');

    if (sending.has(review.id)) return fail(reply, 409, ApiErrorCode.CONFLICT, 'SENDING: these notes are being sent');
    if (!limiter.take(review.id, false))
      return fail(reply, 429, ApiErrorCode.RATE_LIMITED, 'RATE_LIMITED: too many sends for this review; wait a moment');
    sending.add(review.id);
    try {
      const started = await start(req.headers, {
        workingDir: review.repoRoot,
        name: `Review · ${review.title}`.slice(0, 100),
        mode: 'claude',
        launch: {},
      });
      if (!started.ok)
        return fail(reply, 409, ApiErrorCode.OPERATION_FAILED, `START_FAILED: ${started.message}; nothing was sent`);
      const session = ctx.sessions.get(started.sessionId);
      const result = session ? await deliver(deliveryDeps(session, prompt.text), 'paste', Date.now()) : 'not-written';
      if (result === 'not-written' || result === 'not-ready') {
        // Nothing reached the new session, so it would only be an empty tab; the review stays as it was.
        await options.discardSession?.(req.headers, started.sessionId);
        return fail(
          reply,
          409,
          ApiErrorCode.CONFLICT,
          result === 'not-ready'
            ? 'NOT_READY: the new session was not ready for a prompt in time; it was closed and nothing was sent'
            : 'NOT_WRITTEN: the prompt could not be written to the new session; it was closed and nothing was sent'
        );
      }
      const to = { sessionId: started.sessionId, sessionName: session?.name ?? '' };
      const ids = chosen.map((n) => n.id);
      const moved = changeReview(review.id, (r) => ({
        ok: true as const,
        review: stampSent(handOver(r, to), ids, Date.now()),
      }));
      if (moved.ok) announce(moved.review);
      for (const workspaceId of linkSessionToWork(work, started.sessionId, personAuthor(req)))
        options.announceWork?.(workspaceId);
      return {
        success: true,
        data: {
          sessionId: started.sessionId,
          sessionName: to.sessionName,
          sent: moved.ok ? ids : [],
          confirmed: result === 'confirmed' || result === 'unverified',
          work: work.map((w) => handoverWork(w).key),
          review: toView(moved.ok ? moved.review : review),
        },
      };
    } finally {
      sending.delete(review.id);
    }
  });

  // ─── pr-swarm runs ───────────────────────────────────────────────────────

  const swarmHeaders = options.swarmHeaders ?? (async () => null);
  const announceSwarm = (review: Review) =>
    ctx.broadcast(SseEvent.ReviewSwarm, { id: review.id, owner: review.owner ?? '@single' });
  const swarmRefusal = (review: Review) => gitRefusal(authorSession(review), review.repoRoot);
  const swarmDocker = async (): Promise<string[] | null> => {
    try {
      return await dockerWorkspaces();
    } catch {
      return null;
    }
  };
  const swarm =
    options.swarm ??
    createSwarmRunner({
      mayAct: () => deployRole.allows('persist'),
      restored: options.sessionsRestored ?? (() => true),
      now: Date.now,
      newRunId: () => randomBytes(8).toString('hex'),
      reviews: listReviews,
      review: (id) => {
        const read = readReview(id);
        return read.ok ? read.review : null;
      },
      refusal: swarmRefusal,
      tip: (review) => readRunTip(review),
      prepare: async (review, runId, tip) => {
        const roots = await swarmDocker();
        if (!roots) return { ok: false, reason: 'The Docker case list could not be read, so no worktree is made' };
        return prepareRun(review, runId, tip, { dockerWorkspaces: roots, agentSkillDirs: registryAgentSkillDirs() });
      },
      removeWorktree: async (review, runId) => {
        const roots = await swarmDocker();
        if (!roots) return;
        const removed = await removeRunWorktree(review, runId, {
          dockerWorkspaces: roots,
          isInUse: (path) =>
            [...ctx.sessions.values()].some((s) => !s.remote && !!s.workingDir && isPathWithin(s.workingDir, path)),
        });
        if (!removed.ok) console.warn(`[pr-swarm] the worktree of run ${runId} was kept: ${removed.reason}`);
      },
      startSession: async (review, request) => {
        const headers = await swarmHeaders(review.owner ?? null);
        if (!headers || !options.startSession)
          return { ok: false, message: 'this server cannot start a session for the review owner' };
        return options.startSession(headers, { ...request, mode: 'claude', launch: {} });
      },
      send: async (sessionId, text) => {
        const session = ctx.sessions.get(sessionId);
        if (!session) return false;
        const result = await deliver(deliveryDeps(session, text), 'paste', Date.now());
        // Written but unconfirmed counts as sent: sending again would paste it twice.
        return result !== 'not-written' && result !== 'not-ready';
      },
      session: (sessionId) => {
        const session = ctx.sessions.get(sessionId);
        return !session || session.paneExit
          ? { state: 'gone' }
          : { state: 'live', lastActivityAt: session.lastActivityAt };
      },
      stopSession: async (review, sessionId) => {
        const headers = await swarmHeaders(review.owner ?? null);
        if (headers) await options.discardSession?.(headers, sessionId);
        else console.warn(`[pr-swarm] session ${sessionId} was left running: its owner cannot be acted for`);
      },
      announce: announceSwarm,
      log: (text) => console.log(text),
      later: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
      },
      skillsDir: join(homedir(), '.claude', 'plugins', 'marketplaces', 'nicholls', 'pr-swarm', 'skills'),
      ghConfigDir: join(getDataDir(), 'reviews', 'swarm-gh'),
    });
  const watcher = createSwarmWatcher({
    mayAct: () => deployRole.allows('persist'),
    reviews: listReviews,
    runs: (id) => {
      const read = readSwarm(id);
      return read.ok ? read.file : null;
    },
    refusal: swarmRefusal,
    reader: watchTipReader(),
    feed: (id, tip, change) => swarm.tipMoved(id, tip, change),
    log: (text) => console.log(text),
    readTimeoutMs: WATCH_READ_TIMEOUT_MS,
  });
  if (!options.swarm) {
    // One minute tick for both: the runner's queue and the tip watcher. Neither waits for the other.
    const cleanup = new CleanupManager();
    cleanup.setInterval(
      () => {
        void swarm.tick().catch(() => undefined);
        void watcher.pass().catch(() => undefined);
      },
      SWARM_TICK_MS,
      { description: 'pr-swarm runner and tip watcher' }
    );
    cleanup.registerCleanup('watcher', () => watcher.stop(), 'pr-swarm tip watcher');
    app.addHook('onClose', async () => cleanup.dispose());
  }

  /**
   * A submit or resubmit asks for a run of the tip it describes, once its answer has gone out. A refusal or a failure
   * is logged and never reaches the submitter; the runner refuses a colour that is not live, as the submit did.
   */
  const swarmOnSubmit = (review: Review): void => {
    setImmediate(() => {
      swarm.trigger(review.id, 'submit', review.headSha).then(
        (result) => {
          if (!result.ok && result.code !== 'NOT_LIVE')
            console.warn(`[pr-swarm] review ${review.id}: no run on submit: ${result.code}: ${result.message}`);
        },
        (err: unknown) =>
          console.warn(
            `[pr-swarm] review ${review.id}: no run on submit: ${err instanceof Error ? err.message : String(err)}`
          )
      );
    });
  };

  app.get('/api/reviews/:id/swarm', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const read = swarm.view(review.id);
    if (!read.ok)
      return fail(
        reply,
        409,
        ApiErrorCode.CONFLICT,
        read.reason === 'newer' ? 'The run file was saved by a newer release' : 'The run file could not be read'
      );
    return {
      success: true,
      data: { swarm: read.file, live: deployRole.allows('persist'), refusal: watcher.refusalOf(review.id) },
    };
  });

  app.post('/api/reviews/:id/swarm', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    parseBody(SwarmStartSchema, req.body ?? {});
    if (!isOpen(review)) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been decided');
    // Before any git: reading the tip fetches, and git never runs for a remote or Docker case.
    const refused = await gitRefusal(authorSession(review), review.repoRoot);
    if (refused) return fail(reply, 409, ApiErrorCode.CONFLICT, `REFUSED: ${refused}`);
    const tip = await swarm.tipOf(review);
    if (!tip) return fail(reply, 409, ApiErrorCode.CONFLICT, 'TIP_UNREADABLE: the branch tip could not be read');
    const started = await swarm.trigger(review.id, 'manual', tip.sha);
    if (!started.ok)
      return fail(
        reply,
        started.code === 'NOT_FOUND' ? 404 : 409,
        started.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : ApiErrorCode.CONFLICT,
        `${started.code}: ${started.message}`
      );
    if (started.joined)
      return reply.code(409).send({
        ...createErrorResponse(ApiErrorCode.CONFLICT, 'RUNNING: a pr-swarm run is already queued or running'),
        data: { run: started.run },
      });
    return { success: true, data: { run: started.run } };
  });

  app.post('/api/reviews/:id/swarm/resend', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    return fail(reply, 501, ApiErrorCode.OPERATION_FAILED, 'NOT_BUILT: resending findings is not available yet');
  });

  app.post(
    '/api/reviews/swarm-runs/:runId/report',
    async (req: FastifyRequest<{ Params: { runId: string } }>, reply) => {
      const runId = SwarmRunIdSchema.safeParse(req.params.runId);
      if (!runId.success) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, 'That is not a pr-swarm run id');
      const caller = callerSession(ctx, req);
      if (!caller)
        return fail(
          reply,
          403,
          ApiErrorCode.FORBIDDEN,
          "Only the run's own session may report it (X-Codeman-Parent-Session)"
        );
      const body = parseBody(SwarmReportBodySchema, req.body);
      const reported = await swarm.report(runId.data, caller.id, body.report);
      if (reported.ok) return { success: true, data: reported };
      const status =
        reported.code === 'FORBIDDEN'
          ? 403
          : reported.code === 'INVALID'
            ? 400
            : reported.code === 'NOT_RUNNING'
              ? 404
              : 409;
      const code =
        reported.code === 'FORBIDDEN'
          ? ApiErrorCode.FORBIDDEN
          : reported.code === 'INVALID'
            ? ApiErrorCode.INVALID_INPUT
            : reported.code === 'NOT_RUNNING'
              ? ApiErrorCode.NOT_FOUND
              : ApiErrorCode.CONFLICT;
      return fail(reply, status, code, `${reported.code}: ${reported.message}`);
    }
  );
}
