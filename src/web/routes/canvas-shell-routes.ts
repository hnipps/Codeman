/**
 * @fileoverview The canvas shell's read of a workspace's sessions (PC13).
 *
 * `GET /api/canvas/:workspaceId/sessions` lists the live local sessions the caller may see whose working folder is
 * the workspace's case folder or below it (a remote session is left out). Read-only: it starts nothing, writes nothing and never touches a pane.
 * Rows are derived on each request (`src/canvas/shell-sessions.ts`); the kind comes from the workspace's
 * conversation index, the state from the session and the approvals inbox.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CanvasPort, CanvasSession } from '../ports/canvas-port.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import type { AuthUser } from '../../types.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { resolveCasePath } from './case-routes.js';
import { approvalInbox } from '../approval-inbox.js';
import { readConversations } from '../../canvas/conversations.js';
import { taskPart } from '../../canvas/tasks.js';
import { probePathKind } from '../../utils/bounded-path-probe.js';
import { caseFolderAnswered, caseFolderUnavailable } from './canvas-failure.js';
import { MAX_CONCURRENT_SESSIONS_CEILING } from '../../config/map-limits.js';
import {
  deriveSessionState,
  needsYou,
  sessionDisplayName,
  sortSessions,
  type ShellSessionRow,
} from '../../canvas/shell-sessions.js';
import type { Workspace } from '../../canvas/workspace-registry.js';

/** True when `dir` is `folder` or below it: the rule that resolves an agent's `current` workspace. */
export function insideFolder(folder: string, dir: string): boolean {
  const rel = relative(resolve(folder), resolve(dir));
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** The case folder of a workspace, resolved as its owner would resolve it. */
export async function workspaceFolder(workspace: Workspace, user: AuthUser): Promise<string> {
  const caseUser = workspace.owner
    ? { username: workspace.owner, role: workspace.owner === user.username ? user.role : ('user' as const) }
    : user;
  return resolve(await resolveCasePath(workspace.caseName, caseUser));
}

const exited = (session: CanvasSession): boolean => !!session.paneExit;

function row(
  session: CanvasSession,
  kinds: Map<string, { kind: 'conversation' | 'task'; id: string }>
): ShellSessionRow {
  const pending = approvalInbox.getForSession(session.id);
  const state = deriveSessionState({
    // An idle prompt somebody already looked at (or one opened quiet) no longer asks for anyone.
    approval: !pending ? 'none' : pending.kind !== 'idle' ? 'blocking' : pending.acknowledgedAt ? 'none' : 'idle',
    status: session.status,
    exited: exited(session),
    busy: session.hookTurnRunning === true || session.isWorking === true || session.status === 'busy',
  });
  const lastActivityAt = Number(session.lastActivityAt) || 0;
  const lastSubmitAt = Number(session.lastSubmitAt) || 0;
  const since =
    (state === 'needs' || state === 'waiting') && pending
      ? pending.createdAt
      : state === 'working'
        ? lastSubmitAt || lastActivityAt
        : lastActivityAt;
  const carried = kinds.get(session.id);
  return {
    id: session.id,
    name: sessionDisplayName(session),
    mode: session.mode ?? 'claude',
    kind: carried?.kind ?? 'terminal',
    state,
    since,
    lastActivityAt,
    lastSubmitAt,
    ...(carried ? { conversationId: carried.id } : {}),
  };
}

/** The sessions of one workspace the caller may see, in outline order, bounded at the server's session ceiling. */
export function sessionsInside(
  ctx: CanvasPort,
  user: AuthUser,
  workspaceId: string,
  folder: string
): ShellSessionRow[] {
  const kinds = new Map<string, { kind: 'conversation' | 'task'; id: string }>();
  const file = readConversations(workspaceId);
  // An index that cannot be read leaves every row a terminal; the rail reports the index's own state.
  if (file.ok)
    for (const c of file.conversations)
      kinds.set(c.sessionId, { kind: taskPart(c) ? 'task' : 'conversation', id: c.id });
  const rows: ShellSessionRow[] = [];
  for (const session of ctx.sessions.values()) {
    if (rows.length >= MAX_CONCURRENT_SESSIONS_CEILING) break;
    // A remote session's folder is a path on another machine, so it is never inside a local case folder.
    if (session.remote || !canAccessOwned(user, session.owner) || !insideFolder(folder, session.workingDir)) continue;
    rows.push(row(session, kinds));
  }
  return sortSessions(rows);
}

/** `{ live, needsYou }` for the workspace list. A folder that cannot be resolved counts nothing. */
export async function sessionCounts(
  ctx: CanvasPort,
  user: AuthUser,
  workspace: Workspace
): Promise<{ live: number; needsYou: number }> {
  try {
    const rows = sessionsInside(ctx, user, workspace.id, await workspaceFolder(workspace, user));
    return { live: rows.filter((r) => r.state !== 'done').length, needsYou: needsYou(rows) };
  } catch {
    return { live: 0, needsYou: 0 };
  }
}

export function registerShellRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  scope.get<{ Params: { workspaceId: string } }>(
    '/api/canvas/:workspaceId/sessions',
    async (req: FastifyRequest<{ Params: { workspaceId: string } }>, reply) => {
      const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
      const user = getAuthUser(req);
      // The scope's preHandler already answered 404 for a workspace the caller may not open.
      const workspace = readWorkspaces().find((w) => w.id === req.params.workspaceId);
      if (!workspace) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Workspace not found'));
      const folder = await workspaceFolder(workspace, user);
      // The page asks on a timer and on events, not because a person named this folder: the stall cap applies.
      const kind = await probePathKind(folder);
      if (kind === 'unknown') return caseFolderUnavailable(req, reply, folder, { polled: true });
      caseFolderAnswered(req, folder);
      return { success: true, data: { sessions: sessionsInside(ctx, user, workspace.id, folder) } };
    }
  );
}
