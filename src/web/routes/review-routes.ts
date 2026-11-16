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
 *   POST   /api/reviews/:id/notes                a PERSON adds a note { at, text }
 *   PATCH  /api/reviews/:id/notes/:noteId        a PERSON edits or resolves a note { text?, resolved? }
 *   DELETE /api/reviews/:id/notes/:noteId        a PERSON deletes an unsent note
 *   POST   /api/reviews/:id/request-changes      a PERSON sends every unsent note as ONE prompt
 *
 * Who may do what:
 * - Submitting is the agent's act: the request must carry `X-Codeman-Parent-Session`, and the review is made for
 *   THAT session's checked-out branch. Nothing in the body names a repository or a session.
 * - Notes, resolving and Request changes are a person's acts: a request that carries the agent header is refused.
 * - A review belongs to its author session's owner. Every read and write checks it, and a review another user
 *   owns answers 404, like a session does.
 * - Only the live deploy colour writes.
 * - Git never runs for a remote or Docker session, nor for a repository at or inside a Docker case workspace.
 *
 * The prompt is delivered the way a canvas conversation is (`deliver()`): a paste that never reached the pane
 * stamps nothing; one that was written is stamped even when Enter was not confirmed, since sending again would
 * paste it twice.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
import {
  ReviewGitRefusal,
  repoFacts,
  reviewChanges,
  reviewFileDiff,
  SHA,
  tryGit,
  type ReviewChanges,
} from '../../reviews/review-git.js';
import { mergeReviewedBranch, type MergeInput, type MergeResult } from '../../reviews/review-merge.js';
import {
  MAX_OPEN_REVIEWS,
  NoteBodySchema,
  NotePatchSchema,
  ReviewIdSchema,
  SubmitSchema,
  addNote,
  decide,
  isOpen,
  patchNote,
  queueOf,
  removeNote,
  requestChangesPrompt,
  sameWork,
  settledDeploy,
  stampSent,
  submitReview,
  toView,
  unsentNotes,
  type Changed,
  type Decision,
  type Refusal,
  type Review,
} from '../../reviews/review-model.js';
import { changeReview, listReviews, newReviewId, readReview, writeReview } from '../../reviews/review-store.js';
import type { Session } from '../../session.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { webviewCapabilities } from '../../webview-capabilities.js';
import { readWebviews } from '../../webview-store.js';
import { approvalInbox } from '../approval-inbox.js';
import type { EventPort, SessionPort } from '../ports/index.js';
import { canAccessOwned, getAuthUser, isAdmin, parseBody } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import { proxyPrefixFor } from '../webview-proxy.js';
import { deliveryDeps } from './canvas-conversation-routes.js';
import { defaultDockerWorkspaces } from './git-status-routes.js';

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
}

const ApproveSchema = z.object({ headSha: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
/** One merge per repository at a time. */
const merging = new Set<string>();
/** Whether a repository is the one this Codeman is built from, remembered briefly: the answer costs a supervisor call. */
const selfDeployCache = new Map<string, { at: number; value: boolean }>();
const SELF_DEPLOY_TTL_MS = 30_000;
const SETTLE_EVERY_MS = 3_000;
let settledAt = 0;

const PreviewOpenSchema = z.object({ webviewId: z.string().min(1).max(200) }).strict();

const DiffQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const limiter = new SendLimiter();
/** One send per review at a time, so two presses cannot paste the same notes twice. */
const sending = new Set<string>();
/** The file lists of recent reads, so a diff request can check its path without running the listing again. */
const changesCache = new Map<string, { at: number; changes: ReviewChanges }>();
const CHANGES_TTL_MS = 5_000;
const CHANGES_CACHE_MAX = 50;

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

  /**
   * Reads how each deploy a review asked for ended. The colour that asked is stopped by a deploy that succeeds, so
   * the answer is read later, by whichever colour is live, from the supervisor's own record.
   */
  const settleDeploys = async (): Promise<void> => {
    if (Date.now() - settledAt < SETTLE_EVERY_MS || !deployRole.allows('persist')) return;
    settledAt = Date.now();
    const waiting = listReviews().filter((r) => r.decision?.kind === 'deploying');
    const cli = deploy.cli();
    if (!waiting.length || !cli) return;
    let overview: DeployOverviewConfigured;
    try {
      overview = await deploy.readOverview(cli);
    } catch {
      return;
    }
    for (const review of waiting) {
      const next = review.decision ? settledDeploy(review.decision, overview, Date.now()) : null;
      if (!next) continue;
      const changed = changeReview(review.id, (r) => decide(r, next));
      if (changed.ok) announce(changed.review);
    }
  };

  const changesOf = async (review: Review): Promise<ReviewChanges> => {
    const hit = changesCache.get(review.id);
    if (hit && Date.now() - hit.at < CHANGES_TTL_MS) return hit.changes;
    const changes = await reviewChanges(review.repoRoot, review.base, review.branch);
    changesCache.delete(review.id);
    changesCache.set(review.id, { at: Date.now(), changes });
    if (changesCache.size > CHANGES_CACHE_MAX) changesCache.delete(changesCache.keys().next().value as string);
    return changes;
  };

  app.get('/api/reviews', async (req) => {
    await settleDeploys();
    const mine = listReviews().filter((r) => visible(req, r));
    return { success: true, data: queueOf(mine, Date.now()) };
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

    // Read, decide and write with no await between them, so two submissions cannot both make a new review.
    const all = listReviews();
    const owner = session.owner ?? null;
    const open = all.find((r) => isOpen(r) && sameWork(r, session.id, facts));
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
    changesCache.delete(review.id);
    announce(review);
    return reply.code(open ? 200 : 201).send({
      success: true,
      data: { id: review.id, revision: review.revision, state: toView(review).state, url: `reviews/${review.id}` },
    });
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (req, reply) => {
    await settleDeploys();
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const session = ctx.sessions.get(review.sessionId);
    return {
      success: true,
      data: {
        review: toView(review),
        // What the Approve button will do, so the page can say so before it is pressed.
        approve: { deploys: review.decision?.kind === 'merged' ? false : await deploysItself(review.repoRoot) },
        sessionLive: !!session && canAccessOwned(getAuthUser(req), session.owner) && !session.paneExit,
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id/changes', async (req, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const refusal = await gitRefusal(ctx.sessions.get(review.sessionId), review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    const changes = await changesOf(review);
    return { success: true, data: { ...changes, moved: !changes.gone && changes.headSha !== review.headSha } };
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id/diff', async (req, reply) => {
    const review = reviewOf(req, reply);
    if (!review) return reply;
    const { path } = parseBody(DiffQuerySchema, req.query);
    const refusal = await gitRefusal(ctx.sessions.get(review.sessionId), review.repoRoot);
    if (refusal) return fail(reply, 400, ApiErrorCode.INVALID_INPUT, refusal);
    // The path is a key into the branch's own file list, never a path the browser chose.
    const file = (await changesOf(review)).files.find((f) => f.path === path);
    if (!file) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'That file is not part of this review');
    const diff = await reviewFileDiff(review.repoRoot, review.base, review.branch, file);
    if (!diff) return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'The branch is gone');
    return { success: true, data: { path: file.path, origPath: file.origPath, ...diff } };
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
    const review = reviewOf(req, reply);
    if (!review) return reply;
    if (review.decision) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been approved');
    const { headSha } = parseBody(ApproveSchema, req.body);
    const refusal = await gitRefusal(ctx.sessions.get(review.sessionId), review.repoRoot);
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
        branch: review.branch,
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
    if (deploys) {
      const decision = await askForDeploy(mergedSha);
      const second = changeReview(review.id, (r) => decide(r, decision));
      if (second.ok) latest = second.review;
    }
    changesCache.delete(review.id);
    announce(latest);
    return {
      success: true,
      data: {
        review: toView(latest),
        merge: { pushed: merged.pushed, localMoved: merged.localMoved, already: merged.already },
      },
    };
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
      webview.origin.sessionId !== review.sessionId ||
      webview.embedMode === 'direct' ||
      !canAccessOwned(getAuthUser(req), webview.owner)
    )
      return fail(reply, 404, ApiErrorCode.NOT_FOUND, 'That is not a preview of the session that wrote this review');
    const capability = webviewCapabilities.mint(webview.id, webview.owner, { bridge: true });
    return { success: true, data: { embedUrl: proxyPrefixFor(capability, options.basePath ?? '') } };
  });

  app.post<{ Params: { id: string } }>('/api/reviews/:id/request-changes', async (req, reply) => {
    if (!personMayWrite(req, reply)) return reply;
    const review = reviewOf(req, reply);
    if (!review) return reply;
    if (!isOpen(review)) return fail(reply, 409, ApiErrorCode.CONFLICT, 'DECIDED: this review has been decided');
    const session = ctx.sessions.get(review.sessionId);
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
}
