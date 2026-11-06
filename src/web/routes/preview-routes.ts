/**
 * @fileoverview Preview servers a session asks Codeman to run.
 *
 * Endpoints:
 *   GET    /api/previews
 *   GET    /api/sessions/:id/previews
 *   PUT    /api/sessions/:id/previews/:name      { cmd }
 *   GET    /api/sessions/:id/previews/:name
 *   DELETE /api/sessions/:id/previews/:name
 *   GET    /api/sessions/:id/previews/:name/log?tail=<bytes>
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MAX_PREVIEWS_PER_SESSION } from '../../config/preview-limits.js';
import { deployRole } from '../../deploy-role.js';
import {
  PreviewAbandonedError,
  PreviewLimitError,
  PreviewRefusedError,
  type PreviewSupervisor,
} from '../../preview-supervisor.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { PreviewLeftRunningRecord, PreviewProcess, PreviewView, Webview } from '../../types.js';
import { webviewCapabilities } from '../../webview-capabilities.js';
import type { Session } from '../../session.js';
import type { EventPort, SessionPort, TabLayoutPort } from '../ports/index.js';
import { canAccessOwned, findSessionOrFail, getAuthUser, parseBody } from '../route-helpers.js';
import { PreviewLogQuerySchema, PreviewNameSchema, PreviewPutSchema } from '../schemas.js';
import { proxyPrefixFor } from '../webview-proxy.js';
import { createSessionWebview, removeWebview, setWebviewUrl, webviewsById } from './webview-routes.js';

export interface PreviewPort {
  previews: PreviewSupervisor;
}

type PreviewRouteContext = SessionPort & EventPort & TabLayoutPort & PreviewPort;

type PreviewParams = { id: string; name: string };

function loopbackUrl(host: '127.0.0.1' | '::1', port: number): string {
  return host === '::1' ? `http://[::1]:${port}/` : `http://127.0.0.1:${port}/`;
}

function toView(previews: PreviewSupervisor, record: PreviewProcess, webview: Webview | undefined): PreviewView {
  const stillListening = previews.leftRunningOn(record.webviewId);
  return {
    ...record,
    targetUrl: webview?.url ?? loopbackUrl('127.0.0.1', record.port),
    ...(stillListening ? { stillListening } : {}),
  };
}

function unsupportedSessionType(session: Session): string | null {
  if (session.remote) return 'a remote (SSH) session';
  if (session.docker) return 'a Docker session';
  return null;
}

export function registerPreviewRoutes(app: FastifyInstance, ctx: PreviewRouteContext, basePath = ''): void {
  const proxyUrl = (record: PreviewProcess, owner: string | undefined) =>
    proxyPrefixFor(webviewCapabilities.mint(record.webviewId, owner), basePath);

  const previewOf = (req: FastifyRequest<{ Params: PreviewParams }>) => {
    const session = findSessionOrFail(ctx, req.params.id, req);
    const name = parseBody(PreviewNameSchema, req.params.name, 'Invalid preview name');
    return { session, name, record: ctx.previews.get(session.id, name) };
  };

  const notFound = () => createErrorResponse(ApiErrorCode.NOT_FOUND, 'Preview not found');

  const notThisColour = () =>
    deployRole.allows('persist')
      ? null
      : createErrorResponse(ApiErrorCode.CONFLICT, `This server is the ${deployRole.current} deploy colour`);

  const refusedHere = (err: Error) => createErrorResponse(ApiErrorCode.CONFLICT, err.message);
  const refused409 = (err: PreviewRefusedError) =>
    err instanceof PreviewAbandonedError ? refusedHere(err) : (notThisColour() ?? refusedHere(err));

  const leftRunningView = ({ port, pids, sessionId, name, since }: PreviewLeftRunningRecord) => ({
    port,
    pids,
    sessionId,
    name,
    since,
  });

  app.get('/api/previews', async (req) => {
    const user = getAuthUser(req);
    const webviews = await webviewsById();
    const previews = ctx.previews
      .list()
      .filter((r) => canAccessOwned(user, webviews.get(r.webviewId)?.owner ?? ctx.sessions.get(r.sessionId)?.owner))
      .map((r) => toView(ctx.previews, r, webviews.get(r.webviewId)));
    const leftRunning = ctx.previews
      .listLeftRunning()
      .filter((r) => canAccessOwned(user, r.owner ?? ctx.sessions.get(r.sessionId)?.owner))
      .map(leftRunningView);
    return { success: true, data: { previews, leftRunning } };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/previews', async (req) => {
    const session = findSessionOrFail(ctx, req.params.id, req);
    const webviews = await webviewsById();
    const previews = ctx.previews
      .list()
      .filter((r) => r.sessionId === session.id)
      .map((r) => toView(ctx.previews, r, webviews.get(r.webviewId)));
    const leftRunning = ctx.previews
      .listLeftRunning()
      .filter((r) => r.sessionId === session.id)
      .map(leftRunningView);
    return { success: true, data: { previews, leftRunning } };
  });

  app.put<{ Params: PreviewParams }>('/api/sessions/:id/previews/:name', async (req, reply) => {
    const { session, name } = previewOf(req);
    const { cmd } = parseBody(PreviewPutSchema, req.body);
    const unsupported = unsupportedSessionType(session);
    if (unsupported) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            `Previews run on this host, and ${session.name} is ${unsupported}`
          )
        );
    }
    const refused = notThisColour();
    if (refused) return reply.code(409).send(refused);

    let createdId: string | undefined;
    let result;
    try {
      result = await ctx.previews.start(
        { sessionId: session.id, name, cmd, cwd: session.workingDir },
        async (port, existingId) => {
          const url = loopbackUrl('127.0.0.1', port);
          if (existingId && (await setWebviewUrl(ctx, existingId, url))) return existingId;
          const webview = await createSessionWebview(ctx, {
            sessionId: session.id,
            sessionName: session.name,
            name,
            url,
            owner: session.owner,
          });
          createdId = webview.id;
          return webview.id;
        },
        { maxPerSession: MAX_PREVIEWS_PER_SESSION }
      );
    } catch (err) {
      if (createdId && !ctx.previews.forWebview(createdId)) await removeWebview(ctx, createdId);
      if (err instanceof PreviewRefusedError) return reply.code(409).send(refused409(err));
      if (err instanceof PreviewLimitError) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, message));
    }

    const { record, ready, host, leftRunning } = result;
    if (host !== '127.0.0.1') await setWebviewUrl(ctx, record.webviewId, loopbackUrl(host, record.port));
    const current = ctx.previews.forWebview(record.webviewId) ?? record;
    const webview = (await webviewsById()).get(record.webviewId);
    return {
      success: true,
      data: {
        ...toView(ctx.previews, current, webview),
        url: proxyUrl(current, webview?.owner),
        ready,
        ...(leftRunning ? { leftRunning } : {}),
      },
    };
  });

  app.get<{ Params: PreviewParams }>('/api/sessions/:id/previews/:name', async (req, reply) => {
    const { record } = previewOf(req);
    if (!record) return reply.code(404).send(notFound());
    const webview = (await webviewsById()).get(record.webviewId);
    return { success: true, data: { ...toView(ctx.previews, record, webview), url: proxyUrl(record, webview?.owner) } };
  });

  app.delete<{ Params: PreviewParams }>('/api/sessions/:id/previews/:name', async (req, reply) => {
    const { session, name, record } = previewOf(req);
    if (!record) return reply.code(404).send(notFound());
    const refused = notThisColour();
    if (refused) return reply.code(409).send(refused);
    const owner = (await webviewsById()).get(record.webviewId)?.owner ?? session.owner;
    let removal;
    try {
      removal = await ctx.previews.remove(record.webviewId, owner);
    } catch (err) {
      if (err instanceof PreviewRefusedError) return reply.code(409).send(refused409(err));
      throw err;
    }
    await removeWebview(ctx, record.webviewId);
    const leftRunning = removal?.leftRunning;
    return { success: true, data: { name, webviewId: record.webviewId, ...(leftRunning ? { leftRunning } : {}) } };
  });

  app.get<{ Params: PreviewParams; Querystring: { tail?: string } }>(
    '/api/sessions/:id/previews/:name/log',
    async (req, reply) => {
      const { record } = previewOf(req);
      const { tail } = parseBody(PreviewLogQuerySchema, req.query);
      const log = record && (await ctx.previews.readLog(record.webviewId, tail));
      if (!log) return reply.code(404).send(notFound());
      return { success: true, data: { ...log, state: record.state } };
    }
  );
}
