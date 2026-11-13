/**
 * @fileoverview The workspace list, New workspace and the first-run page (PC13): the pure half.
 *
 * A workspace is a case's canvas. The list comes from `GET /api/canvas/workspaces`, the cases from
 * `GET /api/cases`. Creating one is `POST /api/canvas/workspaces` for an existing case, preceded by
 * `POST /api/cases` when the person typed a new name. Nothing here touches the DOM or the network.
 */
import { z } from 'zod';
import { WORKSPACE_ID } from './shell.js';

const WorkspaceSchema = z.object({
  id: z.string().regex(WORKSPACE_ID),
  caseName: z.string().min(1).max(256),
  sessions: z
    .object({ live: z.number().catch(0), needsYou: z.number().catch(0) })
    .optional()
    .catch(undefined),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceSchema>;
/** The caller's workspaces, or null when the answer is not a workspace list. An unreadable entry is left out. */
export function parseWorkspaces(body: unknown): WorkspaceEntry[] | null {
  const parsed = z.object({ data: z.object({ workspaces: z.array(z.unknown()) }) }).safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.data.workspaces.flatMap((w) => {
    const one = WorkspaceSchema.safeParse(w);
    return one.success ? [one.data] : [];
  });
}

export type WorkspaceRow = { id: string; name: string; current: boolean; needsYou: number; label: string };
/** Rows of the list, in the server's order. The count shows only when it is not zero. */
export function workspaceRows(workspaces: readonly WorkspaceEntry[], currentId: string): WorkspaceRow[] {
  return workspaces.map((w) => {
    const needsYou = Math.max(0, Math.floor(w.sessions?.needsYou ?? 0));
    const current = w.id === currentId;
    const waiting = needsYou ? `, ${needsYou} ${needsYou === 1 ? 'session needs' : 'sessions need'} you` : '';
    return {
      id: w.id,
      name: w.caseName,
      current,
      needsYou,
      label: `${w.caseName}${current ? ', open' : ''}${waiting}`,
    };
  });
}

const CaseSchema = z.object({
  name: z.string().min(1).max(256),
  location: z.string().optional().catch(undefined),
  unreachable: z.boolean().optional().catch(undefined),
});
/** `GET /api/cases` answers a bare array; an enveloped one is read too. */
export function parseCases(body: unknown): { name: string; location?: string; unreachable?: boolean }[] | null {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'data' in body && Array.isArray((body as { data: unknown }).data)
      ? (body as { data: unknown[] }).data
      : null;
  if (!list) return null;
  return list.flatMap((c) => {
    const one = CaseSchema.safeParse(c);
    return one.success ? [one.data] : [];
  });
}
/**
 * The cases New workspace offers: local cases that answered and have no canvas yet. Remote and Docker cases are
 * made in the classic view, where their own forms and checks are.
 */
export function caseChoices(
  cases: readonly { name: string; location?: string; unreachable?: boolean }[],
  workspaces: readonly { caseName: string }[]
): string[] {
  const taken = new Set(workspaces.map((w) => w.caseName));
  return cases
    .filter(
      (c) => !taken.has(c.name) && !c.unreachable && (c.location ?? 'local') !== 'remote' && c.location !== 'docker'
    )
    .map((c) => c.name);
}

/** The server's own sentence for a name it would refuse (`CreateCaseSchema`). */
export const CASE_NAME_REFUSAL = 'Invalid case name format. Use only letters, numbers, hyphens, underscores.';
export const MAX_CASE_NAME = 100;
/** Why a typed name cannot be sent, or '' when it can. The server still decides. */
export function caseNameRefusal(name: string): string {
  if (!name) return 'Type a name for the new case.';
  if (name.length > MAX_CASE_NAME) return `Use ${MAX_CASE_NAME} characters or fewer.`;
  return /^[a-zA-Z0-9_-]+$/.test(name) ? '' : CASE_NAME_REFUSAL;
}

/** The reason an answer carries, as text: the envelope's `error`, else a sentence naming the status. */
export function refusalText(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error) return error.slice(0, 300);
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message.slice(0, 300);
  }
  return status ? `Codeman refused this (${status}).` : 'Codeman could not be reached.';
}
/** True when an answer is a success: a 2xx whose envelope, when it has one, does not say otherwise. */
export const succeeded = (ok: boolean, body: unknown): boolean =>
  ok && !(typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false);

/** Where a workspace's canvas lives, relative to the document base. */
export const workspaceHref = (id: string): string => `canvas/${encodeURIComponent(id)}`;
