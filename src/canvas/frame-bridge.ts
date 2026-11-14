/**
 * @fileoverview The script Codeman injects into every canvas frame, a proxied embed or a stored prototype.
 *
 * A canvas frame is sandboxed with an opaque origin, so the canvas cannot reach into it and none of its
 * keys reach the canvas. This script is the only channel: it posts messages to the parent and answers the
 * parent's requests. The page can send the same messages itself, so the parent treats every one as
 * untrusted (see `packages/canvas/src/media.ts`).
 */
export const FRAME_BRIDGE_SCRIPT =
  "<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage({type:'codeman:canvas-escape'},'*')},true)</script>";

/** Put the bridge first in the document, ahead of any script of the page's own. */
export function injectFrameBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return html.slice(0, head.index + head[0].length) + FRAME_BRIDGE_SCRIPT + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + FRAME_BRIDGE_SCRIPT + html.slice(at);
}
