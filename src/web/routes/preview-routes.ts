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
import type { PreviewSupervisor } from '../../preview-supervisor.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { PreviewProcess, PreviewView, Webview } from '../../types.js';
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

function toView(record: PreviewProcess, webview: Webview | undefined): PreviewView {
  return { ...record, targetUrl: webview?.url ?? loopbackUrl('127.0.0.1', record.port) };
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

  app.get('/api/previews', async (req) => {
    const user = getAuthUser(req);
    const webviews = await webviewsById();
    const previews = ctx.previews
      .list()
      .filter((r) => canAccessOwned(user, webviews.get(r.webviewId)?.owner ?? ctx.sessions.get(r.sessionId)?.owner))
      .map((r) => toView(r, webviews.get(r.webviewId)));
    return { success: true, data: { previews } };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/previews', async (req) => {
    const session = findSessionOrFail(ctx, req.params.id, req);
    const webviews = await webviewsById();
    const previews = ctx.previews
      .list()
      .filter((r) => r.sessionId === session.id)
      .map((r) => toView(r, webviews.get(r.webviewId)));
    return { success: true, data: { previews } };
  });

  app.put<{ Params: PreviewParams }>('/api/sessions/:id/previews/:name', async (req, reply) => {
    const { session, name, record: existing } = previewOf(req);
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
    if (!deployRole.allows('persist')) {
      return reply
        .code(409)
        .send(createErrorResponse(ApiErrorCode.CONFLICT, `This server is the ${deployRole.current} deploy colour`));
    }
    const siblings = ctx.previews.list().filter((r) => r.sessionId === session.id && r.name !== name);
    if (!existing && siblings.length >= MAX_PREVIEWS_PER_SESSION) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            `A session can run at most ${MAX_PREVIEWS_PER_SESSION} previews`
          )
        );
    }

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
        }
      );
    } catch (err) {
      if (createdId && !ctx.previews.forWebview(createdId)) await removeWebview(ctx, createdId);
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, message));
    }

    const { record, ready, host } = result;
    if (host !== '127.0.0.1') await setWebviewUrl(ctx, record.webviewId, loopbackUrl(host, record.port));
    const current = ctx.previews.forWebview(record.webviewId) ?? record;
    const webview = (await webviewsById()).get(record.webviewId);
    return {
      success: true,
      data: { ...toView(current, webview), url: proxyUrl(current, webview?.owner), ready },
    };
  });

  app.get<{ Params: PreviewParams }>('/api/sessions/:id/previews/:name', async (req, reply) => {
    const { record } = previewOf(req);
    if (!record) return reply.code(404).send(notFound());
    const webview = (await webviewsById()).get(record.webviewId);
    return { success: true, data: { ...toView(record, webview), url: proxyUrl(record, webview?.owner) } };
  });

  app.delete<{ Params: PreviewParams }>('/api/sessions/:id/previews/:name', async (req, reply) => {
    const { name, record } = previewOf(req);
    if (!record) return reply.code(404).send(notFound());
    await ctx.previews.remove(record.webviewId);
    await removeWebview(ctx, record.webviewId);
    return { success: true, data: { name, webviewId: record.webviewId } };
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
