/** @fileoverview Lazy opt-in canvas service and notifications. */
import type { CanvasStores } from '../../canvas/canvas-store.js';
/** What the canvas needs of a live session: identity for scoping, and the one write primitive a prompt uses. */
export interface CanvasSession {
  id: string;
  owner?: string;
  workingDir: string;
  /** Set while the agent in the pane has exited; the pane itself may still exist. */
  paneExit?: unknown;
  mode?: string;
  writeViaMux?(data: string, options?: { fromUser?: boolean }): Promise<boolean>;
  /** The rendered pane (styled when asked), or null when there is none to read. */
  paneSnapshot?(styles?: boolean): string | null;
  /** When the CLI's own prompt-submitted hook last fired, and whether a hook-reported turn is running. */
  readonly hookPromptSubmittedAt?: number;
  readonly hookTurnRunning?: boolean;
  readonly isWorking?: boolean;
}
export type StartedConversationSession = { ok: true; sessionId: string } | { ok: false; message: string };
export interface CanvasPort {
  readonly sessions: ReadonlyMap<string, CanvasSession>;
  canvasEnabled(): Promise<boolean>;
  canvasStores(): Promise<CanvasStores>;
  broadcast(event: string, data: unknown): void;
  /**
   * Starts one agent session in `workingDir` through the ordinary create and start routes, with the caller's own
   * credentials, so ownership, caps and launch rules are exactly those of a session the person starts themselves.
   * `mode` is the CLI id; `launch` holds only the fields that carry a chosen model (never `modelOverride`).
   */
  startConversationSession?(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    request: { workingDir: string; name: string; mode: string; launch: Record<string, unknown> }
  ): Promise<StartedConversationSession>;
  /** Deletes a session this subsystem started and could not record, the way a failed start is cleaned up. */
  discardConversationSession?(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    sessionId: string
  ): Promise<void>;
  /**
   * The session's transcript as prompt and reply rows, the way `last-response?context=full` reports it; null when it
   * cannot be read. `queued` marks a prompt absorbed in the middle of a turn.
   */
  transcriptRows?(sessionId: string): Promise<{ role: string; text: string; queued?: boolean }[] | null>;
  /** Changes whenever the transcript file does (its identity, modified time and size); null when that cannot be told. */
  transcriptStamp?(sessionId: string): Promise<string | null>;
  /**
   * When THIS process last saw the session's turn end: the stop hook for a CLI that has one, else a finished-turn idle
   * transition. 0 when it has seen none, which is the case for every session after a restart.
   */
  turnEndObservedAt?(sessionId: string): number;
  /** Reverse-proxy base path for embed frame URLs; '' at the root. */
  readonly basePath?: string;
}
