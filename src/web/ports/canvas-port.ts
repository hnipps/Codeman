/** @fileoverview Lazy opt-in canvas service and notifications. */
import type { CanvasStores } from '../../canvas/canvas-store.js';
/** What the canvas needs of a live session: identity for scoping, and the one write primitive a prompt uses. */
export interface CanvasSession {
  id: string;
  owner?: string;
  workingDir: string;
  /** Set while the agent in the pane has exited; the pane itself may still exist. */
  paneExit?: unknown;
  writeViaMux?(data: string, options?: { fromUser?: boolean }): Promise<boolean>;
}
export type StartedConversationSession = { ok: true; sessionId: string } | { ok: false; message: string };
export interface CanvasPort {
  readonly sessions: ReadonlyMap<string, CanvasSession>;
  canvasEnabled(): Promise<boolean>;
  canvasStores(): Promise<CanvasStores>;
  broadcast(event: string, data: unknown): void;
  /**
   * Starts one Claude session in `workingDir` through the ordinary create and start routes, with the caller's own
   * credentials, so ownership, caps and launch rules are exactly those of a session the person starts themselves.
   */
  startConversationSession?(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    request: { workingDir: string; name: string }
  ): Promise<StartedConversationSession>;
  /** Reverse-proxy base path for embed frame URLs; '' at the root. */
  readonly basePath?: string;
}
