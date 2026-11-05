/**
 * @fileoverview Preview servers: dev servers Codeman starts for a session and
 * shows through a session-origin web tab.
 */

/**
 * - `running`: the server's processes are alive, or were at the last check.
 * - `stopped`: Codeman stopped it (idle timeout); the record and its web tab stay.
 * - `exited`: every process of the preview ended on its own.
 */
export type PreviewState = 'running' | 'stopped' | 'exited';

export interface PreviewProcess {
  /** The session-origin web tab this server backs; also the value of its `CODEMAN_PREVIEW_ID`. */
  webviewId: string;
  sessionId: string;
  /** Unique per session. */
  name: string;
  /** As given, with the `{port}` placeholder. */
  cmd: string;
  /** The session's workingDir. */
  cwd: string;
  port: number;
  /** The `/bin/sh` that ran `cmd`, leader of its own process group. */
  pid: number;
  pgid: number;
  /** Field 22 of `/proc/<pid>/stat`. A pid whose start time differs is a different process. */
  startTicks: number;
  logPath: string;
  state: PreviewState;
  lastViewedAt: number;
}

/** A preview as the API returns it. */
export interface PreviewView extends PreviewProcess {
  /** Where the server listens, as the proxy reaches it. */
  targetUrl: string;
  /** Same-origin proxy path that serves the preview. Present on PUT and single GET. */
  url?: string;
  /** True once the port accepted a connection during the PUT. */
  ready?: boolean;
}
