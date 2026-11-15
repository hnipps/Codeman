/**
 * @fileoverview A principal the server mints for its own `app.inject` calls (W-44 canvas routines). The routine runner
 * starts a run through the same `POST /api/canvas/:ws/tasks` a person's click reaches, so every agent-start bound
 * applies; this header is how that call says who it acts as with no browser behind it.
 *
 * The value is `<base64url json>.<hmac>`. The HMAC key is 32 random bytes made when this module loads and never
 * written, logged or sent, so only this process can mint a valid header; a client that sends one is ignored. A header
 * names the user it acts as, expires after `INTERNAL_PRINCIPAL_TTL_MS`, and a routine header is bound to one
 * workspace and one routine. The webview proxy drops it on the way out.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../types.js';

export const INTERNAL_PRINCIPAL_HEADER = 'x-codeman-internal';
/** Long enough for a start that makes a worktree and then creates the session with the same header; short enough
 * that a header copied into a log is useless by the time anyone reads it. */
export const INTERNAL_PRINCIPAL_TTL_MS = 5 * 60_000;

export type RoutinePrincipal = { routineId: string; runId: string; workspaceId: string };
export type InternalPrincipal = { user: AuthUser; routine?: RoutinePrincipal };

const KEY = randomBytes(32);
const Payload = z
  .object({
    user: z.object({ username: z.string().min(1).max(128), role: z.enum(['admin', 'user']) }).strict(),
    routine: z
      .object({
        routineId: z.string().min(1).max(128),
        runId: z.string().min(1).max(128),
        workspaceId: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    expiresAt: z.number().int(),
  })
  .strict();

const mac = (body: string): Buffer => createHmac('sha256', KEY).update(body).digest();

export function internalHeaders(principal: InternalPrincipal, now: number): Record<string, string> {
  const body = Buffer.from(
    JSON.stringify({ ...principal, expiresAt: now + INTERNAL_PRINCIPAL_TTL_MS }),
    'utf8'
  ).toString('base64url');
  return { [INTERNAL_PRINCIPAL_HEADER]: `${body}.${mac(body).toString('base64url')}` };
}

/** The verified principal a header value carries, or undefined (absent, malformed, a bad MAC, or expired). */
export function verifyInternalPrincipal(value: unknown, now: number): InternalPrincipal | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra !== undefined) return undefined;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = Payload.safeParse(json);
  if (!parsed.success || parsed.data.expiresAt <= now) return undefined;
  const { user, routine } = parsed.data;
  return routine ? { user, routine } : { user };
}

/**
 * The first `onRequest` hook: a verified header sets the caller's identity, which the credential hooks then leave
 * alone. Registered before them (`registerAuthMiddleware`), and with no password set as well, since the canvas reads
 * the routine part either way.
 */
export function registerInternalPrincipal(app: FastifyInstance): void {
  if (!app.hasRequestDecorator('internalPrincipal')) app.decorateRequest('internalPrincipal', undefined);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const principal = verifyInternalPrincipal(req.headers[INTERNAL_PRINCIPAL_HEADER], Date.now());
    if (!principal) return;
    req.internalPrincipal = principal;
    req.authUser = principal.user;
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    internalPrincipal?: InternalPrincipal;
    /** Set by the canvas workspace pre-handler from a verified routine principal, never from a client header. */
    canvasRoutine?: RoutinePrincipal;
  }
}
