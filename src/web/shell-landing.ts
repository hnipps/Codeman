/**
 * @fileoverview What `/` answers with when the canvas may be Codeman's landing page (PC13).
 *
 * Pure. The caller reads the settings, the query, the canvas files and the caller's own workspaces and
 * gets back one of three answers: the classic dashboard (with a notice when the canvas was wanted and
 * could not be shown), the canvas of one workspace, or the first-run page. With either setting off the
 * answer is always the plain dashboard, which is what keeps `/` unchanged for everyone who has not
 * turned the shell on.
 */

/** Why the classic view is being shown in place of the canvas. A fixed list: nothing from a request is echoed. */
export const SHELL_NOTICES = ['missing', 'load', 'boot'] as const;
export type ShellNotice = (typeof SHELL_NOTICES)[number];

/** Workspace ids as the canvas routes accept them. */
export const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
/** The per-device memory of the workspace last opened: a preference, never a credential. */
export const LAST_WORKSPACE_COOKIE = 'codeman_canvas_ws';

export type LandingInput = {
  canvasEnabled: boolean;
  shellEnabled: boolean;
  /** The raw query of the request, already parsed (`view`, `canvas`, `reason`). */
  query: { view?: unknown; canvas?: unknown; reason?: unknown };
  /** False when a file the canvas document needs is not on disk. */
  bundlePresent: boolean;
  /** Only the workspaces the caller may open, in registry order. */
  workspaces: readonly { id: string; caseName: string }[];
  cookieWorkspaceId?: string;
  lastUsedCase?: string;
};
export type Landing =
  | { kind: 'classic'; shell: boolean; notice: ShellNotice | null }
  | { kind: 'canvas'; workspaceId: string }
  | { kind: 'first-run' };

/** True when both settings are on: the only combination in which anything about `/` changes. */
export const shellActive = (settings: { canvasEnabled?: unknown; canvasShellEnabled?: unknown }): boolean =>
  settings.canvasEnabled === true && settings.canvasShellEnabled === true;

const noticeFrom = (query: LandingInput['query']): ShellNotice | null => {
  if (query.canvas !== 'failed') return null;
  const reason = SHELL_NOTICES.find((r) => r === query.reason);
  // An unknown or missing reason still says the canvas failed; `boot` is the least specific sentence.
  return reason ?? 'boot';
};

export function decideLanding(input: LandingInput): Landing {
  const shell = input.canvasEnabled && input.shellEnabled;
  // A shell that is off changes nothing, whatever the query says.
  if (!shell) return { kind: 'classic', shell: false, notice: null };
  if (input.query.view === 'classic') return { kind: 'classic', shell: true, notice: noticeFrom(input.query) };
  if (!input.bundlePresent) return { kind: 'classic', shell: true, notice: 'missing' };
  const cookie = input.cookieWorkspaceId;
  if (cookie && WORKSPACE_ID_PATTERN.test(cookie)) {
    const remembered = input.workspaces.find((w) => w.id === cookie);
    if (remembered) return { kind: 'canvas', workspaceId: remembered.id };
  }
  if (input.lastUsedCase) {
    const last = input.workspaces.find((w) => w.caseName === input.lastUsedCase);
    if (last) return { kind: 'canvas', workspaceId: last.id };
  }
  const first = input.workspaces[0];
  return first ? { kind: 'canvas', workspaceId: first.id } : { kind: 'first-run' };
}

/** One cookie's value out of a `Cookie` header, undecodable or absent as undefined. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
