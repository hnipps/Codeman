/**
 * @fileoverview The two requests that make a workspace (PC13), shared by the outline's New workspace and the
 * first-run page: open an existing case's canvas, and create a case and then its canvas.
 *
 * Both go through routes that already exist and already check ownership, names and the live deploy colour.
 */
import { z } from 'zod';
import { WORKSPACE_ID } from './shell.js';
import { caseNameRefusal, refusalText, succeeded } from './workspaces.js';

export type Made = { ok: true; workspaceId: string } | { ok: false; reason: string };
type Url = (path: string) => string;
const Created = z.object({ data: z.object({ workspace: z.object({ id: z.string().regex(WORKSPACE_ID) }) }) });

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** The canvas of a case that exists: makes its workspace when it has none, and names it. */
export async function workspaceOfCase(url: Url, caseName: string): Promise<Made> {
  const answer = await post(url('/api/canvas/workspaces'), { caseName });
  if (!succeeded(answer.ok, answer.body)) return { ok: false, reason: refusalText(answer.status, answer.body) };
  const parsed = Created.safeParse(answer.body);
  return parsed.success
    ? { ok: true, workspaceId: parsed.data.data.workspace.id }
    : { ok: false, reason: 'Codeman answered in a form this page cannot read.' };
}

/** A new case by name, then its canvas. A refused name returns the server's reason and nothing else is tried. */
export async function createCaseWorkspace(url: Url, name: string): Promise<Made> {
  const refusal = caseNameRefusal(name);
  if (refusal) return { ok: false, reason: refusal };
  const made = await post(url('/api/cases'), { name });
  if (!succeeded(made.ok, made.body)) return { ok: false, reason: refusalText(made.status, made.body) };
  return workspaceOfCase(url, name);
}
