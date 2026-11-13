/**
 * @fileoverview What a canvas page knows about being Codeman's shell (PC13).
 *
 * The facts come from the document: the inline boot guard in `canvas.html` publishes `window.__canvasBoot`,
 * and the server writes the shell and workspace meta tags only while both canvas settings are on. A canvas
 * shown as a tab inside the dashboard is framed, so the guard reports `shell: false` there and nothing in
 * this file acts.
 */
declare global {
  interface Window {
    __canvasBoot?: {
      ok: boolean;
      /** The shell is on and this page is the top-level page. */
      shell: boolean;
      /** A saved copy of the canvas document was served for an address that asks for the classic view. */
      stale: boolean;
      navigations: number;
      ready(): void;
      fail(reason: 'load' | 'boot'): void;
    };
  }
}

/** Workspace ids as the canvas routes accept them. */
export const WORKSPACE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
/** Session ids as a page address may carry them. */
export const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
/** The per-device memory of the workspace last opened. A preference the server validates, never a credential. */
export const LAST_WORKSPACE_COOKIE = 'codeman_canvas_ws';

export const shellOn = (win: Window = window): boolean => win.__canvasBoot?.shell === true;
export const shellStale = (win: Window = window): boolean => win.__canvasBoot?.stale === true;
/** Tells the boot guard the page drew the board or one of its own states. After this the guard never navigates. */
export const bootReady = (win: Window = window): void => win.__canvasBoot?.ready();

/**
 * The workspace this page shows: the server's meta tag on a shell page, else the last path segment, which is what
 * a canvas tab in the dashboard has always used.
 */
export function pageWorkspaceId(doc: Document = document, path: string = location.pathname): string {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="codeman-canvas-workspace"]')?.content ?? '';
  if (WORKSPACE_ID.test(meta)) return meta;
  return path.split('/').filter(Boolean).at(-1) ?? '';
}

/** The cookie that makes `/` open this workspace next time on this device. `basePath` is '' at the root. */
export function lastWorkspaceCookie(workspaceId: string, basePath: string, secure: boolean): string | null {
  if (!WORKSPACE_ID.test(workspaceId)) return null;
  const year = 60 * 60 * 24 * 365;
  return `${LAST_WORKSPACE_COOKIE}=${workspaceId}; Path=${basePath || '/'}; Max-Age=${year}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function rememberWorkspace(workspaceId: string, basePath: string, doc: Document = document): void {
  const cookie = lastWorkspaceCookie(workspaceId, basePath, location.protocol === 'https:');
  if (!cookie) return;
  try {
    doc.cookie = cookie;
  } catch {
    /* A browser that refuses cookies opens the server's own choice next time. */
  }
}
