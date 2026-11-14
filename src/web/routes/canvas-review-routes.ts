/**
 * @fileoverview Review notes on a canvas text object (`src/canvas/review-notes.ts`).
 *
 * `GET  /api/canvas/:workspaceId/review-notes` the notes of comments that sit on text objects now.
 * `PUT  /api/canvas/:workspaceId/review-notes/:commentId` sets one note's kind, words and resolved state, after its comment is posted.
 * `POST /api/canvas/:workspaceId/review/:objectId/send` delivers the named unsent notes in ONE prompt and stamps exactly those.
 *
 * Sending is a person's press only: an agent caller is refused. The prompt goes to the session that wrote the object,
 * or to a session the person picked from the workspace's own sessions when that one has ended. It is delivered the
 * way a canvas conversation is (`deliver()`): a paste that never reached the pane stamps nothing; one that was
 * written is stamped even when Enter was not confirmed, since sending it again would paste it twice.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CanvasPort } from '../ports/canvas-port.js';
import { canAccessOwned, getAuthUser, ownerFor } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { deployRole } from '../../deploy-role.js';
import { SseEvent } from '../sse-events.js';
import { approvalInbox } from '../approval-inbox.js';
import { IdSchema } from '../../canvas/model.js';
import { plainLine } from '../../canvas/context-resolve.js';
import { deliver } from '../../canvas/conversation-delivery.js';
import { SendLimiter } from '../../canvas/send-limit.js';
import { readReviewNotes, reviewPrompt, setReviewNote, stampSent, type PromptNote } from '../../canvas/review-notes.js';
import { MAX_NOTES_PER_SEND, noteState, ReviewNoteBodySchema } from '../../canvas/review-schema.js';
import { locate } from '../../canvas/review-anchor.js';
import { deliveryDeps } from './canvas-conversation-routes.js';
import { sessionsInside, workspaceFolder } from './canvas-shell-routes.js';

const SendSchema = z
  .object({
    commentIds: z.array(IdSchema).min(1).max(MAX_NOTES_PER_SEND),
    /** Only when the object's writer has ended: a session of this workspace the person picked. */
    sessionId: IdSchema.optional(),
  })
  .strict();

const limiter = new SendLimiter();
/** One send per object at a time, so two presses cannot paste the same notes twice. */
const sending = new Set<string>();

const fail = (code: number, errorCode: ApiErrorCode, message: string) => ({
  code,
  body: createErrorResponse(errorCode, message),
});

export function registerReviewRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  const announce = async (workspaceId: string, seq: number) => {
    const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
    ctx.broadcast(SseEvent.CanvasChanged, {
      workspaceId,
      seq,
      owner: readWorkspaces().find((w) => w.id === workspaceId)?.owner,
      reviewNotes: true,
    });
  };

  scope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/review-notes', async (req) => {
    const state = (await ctx.canvasStores()).get(req.params.workspaceId).read();
    return { success: true, data: { notes: readReviewNotes(req.params.workspaceId, state) } };
  });

  scope.put<{ Params: { workspaceId: string; commentId: string } }>(
    '/api/canvas/:workspaceId/review-notes/:commentId',
    async (req, reply) => {
      if (!deployRole.allows('persist'))
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
      const commentId = IdSchema.parse(req.params.commentId);
      const body = ReviewNoteBodySchema.parse(req.body);
      const store = (await ctx.canvasStores()).get(req.params.workspaceId);
      const state = store.read();
      const outcome = setReviewNote(req.params.workspaceId, state, commentId, body, Date.now());
      if (outcome === 'no-comment')
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.CONFLICT, 'NO_COMMENT: post the comment on a text object first'));
      if (outcome === 'unreadable')
        return reply
          .code(409)
          .send(
            createErrorResponse(ApiErrorCode.CONFLICT, 'UNREADABLE: the review notes file is from another release')
          );
      await announce(req.params.workspaceId, state.seq);
      return { success: true, data: { note: readReviewNotes(req.params.workspaceId, state)[commentId] } };
    }
  );

  scope.post<{ Params: { workspaceId: string; objectId: string } }>(
    '/api/canvas/:workspaceId/review/:objectId/send',
    async (req, reply) => {
      const result = await send(ctx, req, req.params.workspaceId, req.params.objectId, req.body);
      if (result.code === 200)
        await announce(req.params.workspaceId, (await ctx.canvasStores()).get(req.params.workspaceId).read().seq);
      return reply.code(result.code).send(result.body);
    }
  );
}

async function send(ctx: CanvasPort, req: FastifyRequest, workspaceId: string, rawObjectId: string, input: unknown) {
  if (req.canvasAuthor?.kind === 'agent')
    return fail(403, ApiErrorCode.FORBIDDEN, 'Review notes are sent by a person only');
  if (!deployRole.allows('persist'))
    return fail(409, ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data');
  const objectId = IdSchema.parse(rawObjectId);
  const body = SendSchema.parse(input);
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const workspace = readWorkspaces().find((w) => w.id === workspaceId);
  if (!workspace || workspace.owner !== ownerFor(req)) return fail(404, ApiErrorCode.NOT_FOUND, 'Workspace not found');
  const store = (await ctx.canvasStores()).get(workspaceId);
  let state = store.read();
  const object = state.objects[objectId];
  if (!object || object.deletedAt !== null || object.type !== 'text' || object.content.type !== 'text')
    return fail(404, ApiErrorCode.NOT_FOUND, 'NOT_FOUND: that text object is not on the canvas');
  const text = typeof object.content.text === 'string' ? object.content.text : '';

  // The writer, while it runs; otherwise only a session the person picked from this workspace's own.
  const user = getAuthUser(req);
  const writer = object.author.kind === 'agent' ? ctx.sessions.get(object.author.sessionId) : undefined;
  const writerLive = !!writer && canAccessOwned(user, writer.owner) && !writer.paneExit;
  let session = writerLive ? writer : undefined;
  if (body.sessionId && body.sessionId !== writer?.id) {
    if (writerLive)
      return fail(409, ApiErrorCode.CONFLICT, 'WRITER_LIVE: the session that wrote this is still running');
    const rows = sessionsInside(ctx, user, workspaceId, await workspaceFolder(workspace, user));
    if (!rows.some((r) => r.id === body.sessionId && r.state !== 'done'))
      return fail(409, ApiErrorCode.CONFLICT, 'SESSION_ENDED: pick a running session of this canvas');
    session = ctx.sessions.get(body.sessionId);
  }
  if (!session || session.paneExit)
    return fail(409, ApiErrorCode.CONFLICT, 'SESSION_ENDED: the session that wrote this has ended; pick another');
  const pending = approvalInbox.getForSession(session.id);
  if (pending && pending.kind !== 'idle')
    return fail(409, ApiErrorCode.CONFLICT, 'APPROVAL_PENDING: answer the pending question in that session first');

  const notes = readReviewNotes(workspaceId, state);
  const comments = new Map(state.comments.filter((c) => c.objectId === objectId).map((c) => [c.id, c]));
  const chosen: PromptNote[] = [];
  for (const id of new Set(body.commentIds)) {
    const note = notes[id];
    const comment = comments.get(id);
    // A note already sent or resolved is left out, so a repeated press never sends it again.
    if (!note || !comment || noteState(note) !== 'unsent') continue;
    chosen.push({
      commentId: id,
      note,
      text: comment.text,
      located: note.kind === 'general' || locate(text, note.anchor) !== null,
    });
  }
  const label = plainLine(text.split('\n').find((l) => l.trim()) ?? '', 80) || 'Untitled text';
  const prompt = reviewPrompt({ id: objectId, label }, chosen);
  if ('refusal' in prompt)
    return fail(
      chosen.length ? 400 : 409,
      chosen.length ? ApiErrorCode.INVALID_INPUT : ApiErrorCode.CONFLICT,
      prompt.refusal
    );

  const key = `${workspaceId}:${objectId}`;
  if (sending.has(key)) return fail(409, ApiErrorCode.CONFLICT, 'SENDING: these notes are already being sent');
  if (!limiter.take(key, false))
    return fail(429, ApiErrorCode.RATE_LIMITED, 'RATE_LIMITED: too many sends from this text; wait a moment');
  sending.add(key);
  try {
    const result = await deliver(deliveryDeps(session, prompt.text), 'paste', Date.now());
    if (result === 'not-written' || result === 'not-ready')
      return fail(
        409,
        ApiErrorCode.CONFLICT,
        result === 'not-ready'
          ? 'NOT_READY: the session was not ready for a prompt; nothing was sent'
          : 'NOT_WRITTEN: the prompt could not be written to the session; nothing was sent'
      );
    // The paste reached the pane. Read the state again: the notes may have changed while it waited.
    state = store.read();
    const ids = chosen.map((c) => c.commentId);
    const stamped = stampSent(workspaceId, state, ids, Date.now());
    return {
      code: 200,
      body: {
        success: true,
        data: {
          sent: stamped === 'ok' ? ids : [],
          sessionId: session.id,
          confirmed: result === 'confirmed' || result === 'unverified',
          prompt: prompt.text,
        },
      },
    };
  } finally {
    sending.delete(key);
  }
}
