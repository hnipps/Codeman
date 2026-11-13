/**
 * @fileoverview Posts this page's uncaught errors and unhandled rejections to `POST /api/client-errors`, as
 * the dashboard does: at most `MAX_REPORTS` distinct errors a load, fire-and-forget. It only listens, so the
 * boot guard in `canvas.html` sees the same events.
 */
export const MAX_REPORTS = 20;

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined;
const position = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

export function reportClientErrors(url: (path: string) => string, win: Window = window): void {
  const seen = new Set<string>();
  const report = (message: unknown, stack: unknown, source?: unknown, line?: unknown, col?: unknown): void => {
    try {
      const key = `${String(message)}|${String(source)}|${String(line)}|${String(col)}`;
      if (seen.has(key) || seen.size >= MAX_REPORTS) return;
      seen.add(key);
      void win
        .fetch(url('/api/client-errors'), {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: cap(String(message ?? ''), 2000) || 'unknown error',
            source: cap(source, 500),
            line: position(line),
            col: position(col),
            stack: cap(stack, 8000),
            url: cap(win.location.pathname, 500),
          }),
        })
        .catch(() => undefined);
    } catch {
      /* The reporter must never raise an error of its own: that would re-enter these listeners. */
    }
  };
  win.addEventListener('error', (event) => {
    // A resource that failed to load fires a plain event here only in capture; this is a script error.
    report(
      event.message,
      (event.error as { stack?: unknown } | null)?.stack,
      event.filename,
      event.lineno,
      event.colno
    );
  });
  win.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: unknown; stack?: unknown } | null;
    report(reason?.message || String(event.reason), reason?.stack);
  });
}
