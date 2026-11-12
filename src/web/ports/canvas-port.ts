/** @fileoverview Lazy opt-in canvas service and notifications. */
import type { CanvasStores } from '../../canvas/canvas-store.js';
export interface CanvasPort {
  readonly sessions: ReadonlyMap<string, { id: string; owner?: string; workingDir: string }>;
  canvasEnabled(): Promise<boolean>;
  canvasStores(): Promise<CanvasStores>;
  broadcast(event: string, data: unknown): void;
  /** Reverse-proxy base path for embed frame URLs; '' at the root. */
  readonly basePath?: string;
}
