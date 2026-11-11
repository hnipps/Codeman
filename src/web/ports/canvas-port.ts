/** @fileoverview Lazy opt-in canvas service and notifications. */
import type { CanvasStores } from '../../canvas/canvas-store.js';
export interface CanvasPort {
  canvasEnabled(): Promise<boolean>;
  canvasStores(): Promise<CanvasStores>;
  broadcast(event: string, data: unknown): void;
}
