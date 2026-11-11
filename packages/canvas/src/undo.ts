import type { Acknowledged, CanvasRequest } from './edit-queue.js';
type Entry = { sequences: number[]; focusId: string | null };
export class CanvasUndo {
  private undo: Entry[] = [];
  private redo: Entry[] = [];
  private pending: { direction: 'undo' | 'redo'; focusId: string | null } | null = null;
  acknowledge(operations: Acknowledged[], focusId: string | null): string | null {
    if (!operations.length) {
      // A no-op answer wrote nothing, so a pending history step stays where it was.
      this.pending = null;
      return null;
    }
    const sequences = operations.map((op) => op.seq);
    const pending = this.pending;
    if (pending) {
      (pending.direction === 'undo' ? this.undo : this.redo).pop();
      (pending.direction === 'undo' ? this.redo : this.undo).push({ sequences, focusId: pending.focusId });
      this.pending = null;
      return pending.focusId;
    }
    this.undo.push({ sequences, focusId });
    this.redo = [];
    return null;
  }
  prepare(direction: 'undo' | 'redo'): CanvasRequest | null {
    if (this.pending) throw new Error('Wait for the previous history edit to save.');
    const entry = (direction === 'undo' ? this.undo : this.redo).at(-1);
    if (!entry) return null;
    this.pending = { direction, focusId: entry.focusId };
    return { tool: 'canvas_history', arguments: { action: direction, sequences: entry.sequences } };
  }
  available(direction: 'undo' | 'redo'): boolean {
    return !this.pending && (direction === 'undo' ? this.undo : this.redo).length > 0;
  }
  refused(): void {
    this.pending = null;
  }
}
