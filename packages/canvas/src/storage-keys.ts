/** Per-viewer localStorage keys for the canvas edit queue, drafts and clipboard. */
export const SINGLE_USER_VIEWER = '@single';
/** A stored clipboard larger than this is refused rather than written. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type CanvasStorageKeys = {
  edits: string;
  drafts: string;
  clipboard: string;
  assistantDraft: string;
  assistantContext: string;
  assistantOutbox: string;
  assistantSent: string;
  assistantChoice: string;
  threadAsk: string;
};
export function canvasStorageKeys(viewer: string, workspace: string): CanvasStorageKeys {
  const scope = `codeman:canvas:user:${encodeURIComponent(viewer)}`;
  return {
    edits: `${scope}:${workspace}:edits`,
    drafts: `${scope}:${workspace}:drafts`,
    clipboard: `${scope}:clipboard`,
    assistantDraft: `${scope}:${workspace}:assistant:draft`,
    assistantContext: `${scope}:${workspace}:assistant:context`,
    assistantOutbox: `${scope}:${workspace}:assistant:outbox`,
    assistantSent: `${scope}:${workspace}:assistant:sent`,
    assistantChoice: `${scope}:${workspace}:assistant:choice`,
    threadAsk: `${scope}:${workspace}:thread:ask`,
  };
}
/**
 * Keys from before per-viewer scoping held another user's text in a shared browser profile. They are removed;
 * only a single-user install, where every entry is the same person's, adopts them once.
 */
export function retireUnscopedKeys(storage: Store, viewer: string, workspace: string): void {
  const scoped = canvasStorageKeys(viewer, workspace);
  const legacy: [string, string][] = [
    [`codeman:canvas:${workspace}:edits`, scoped.edits],
    [`codeman:canvas:${workspace}:drafts`, scoped.drafts],
    ['codeman:canvas:clipboard', scoped.clipboard],
  ];
  for (const [old, current] of legacy) {
    try {
      const value = storage.getItem(old);
      if (value === null) continue;
      if (viewer === SINGLE_USER_VIEWER && storage.getItem(current) === null) storage.setItem(current, value);
      storage.removeItem(old);
    } catch {
      /* Storage that cannot be read or written keeps nothing to adopt. */
    }
  }
}
export const clipboardTooLarge = (serialized: string): boolean =>
  new TextEncoder().encode(serialized).byteLength > MAX_CLIPBOARD_BYTES;
