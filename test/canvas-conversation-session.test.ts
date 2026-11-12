import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';

type Started = { ok: true; sessionId: string } | { ok: false; message: string };
type Internals = {
  startConversationSession(
    h: Record<string, string>,
    r: { workingDir: string; name: string; mode: string; launch: Record<string, unknown> }
  ): Promise<Started>;
  discardConversationSession(h: Record<string, string>, id: string): Promise<void>;
  app: { inject: (...a: unknown[]) => Promise<unknown> };
  sessions: Map<string, Session>;
  respawnControllers: Map<string, unknown>;
};
describe('WebServer.startConversationSession', () => {
  let server: WebServer;
  let internals: Internals;
  const workingDir = resolve(resolveCasesDir(), 'conv-session-case');
  beforeAll(async () => {
    mkdirSync(workingDir, { recursive: true });
    server = new WebServer(0, false, true);
    await server.start();
    internals = server as unknown as Internals;
  }, 60000);
  afterAll(async () => {
    await server?.stop();
  }, 60000);

  it('creates one claude session through the ordinary routes with no respawn, auto-resume, Ralph or keep-warm field', async () => {
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const inject = internals.app.inject.bind(internals.app);
    const spy = vi.spyOn(internals.app, 'inject').mockImplementation((opts: unknown) => {
      const o = opts as { url: string; payload?: Record<string, unknown> };
      bodies.push({ url: o.url, payload: o.payload ?? {} });
      return inject(opts);
    });
    try {
      const started = await internals.startConversationSession(
        {},
        { workingDir, name: 'Canvas · test', mode: 'claude', launch: {} }
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(bodies[0].url).toBe('/api/sessions');
      expect(Object.keys(bodies[0].payload).sort()).toEqual(['mode', 'name', 'workingDir']);
      expect(bodies[0].payload.mode).toBe('claude');
      expect(bodies[1].url).toBe(`/api/sessions/${started.sessionId}/interactive`);
      expect(Object.keys(bodies[1].payload)).toEqual([]);
      const session = internals.sessions.get(started.sessionId)!;
      expect(session.ralphTracker.enabled).toBe(false);
      expect(internals.respawnControllers.has(started.sessionId)).toBe(false);
      expect(session.toState().autoResume ?? false).toBeFalsy();
      await internals.discardConversationSession({}, started.sessionId);
      expect(internals.sessions.has(started.sessionId)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('sends a chosen model as the per-session field and never modelOverride', async () => {
    const bodies: Record<string, unknown>[] = [];
    const inject = internals.app.inject.bind(internals.app);
    const spy = vi.spyOn(internals.app, 'inject').mockImplementation((opts: unknown) => {
      const o = opts as { url: string; payload?: Record<string, unknown> };
      if (o.url === '/api/sessions') bodies.push(o.payload ?? {});
      return inject(opts);
    });
    try {
      const started = await internals.startConversationSession(
        {},
        { workingDir, name: 'Canvas · model', mode: 'claude', launch: { model: 'opus[1m]' } }
      );
      expect(started.ok).toBe(true);
      expect(bodies[0]).toEqual({ workingDir, mode: 'claude', name: 'Canvas · model', model: 'opus[1m]' });
      expect(bodies[0]).not.toHaveProperty('modelOverride');
      if (started.ok) await internals.discardConversationSession({}, started.sessionId);
    } finally {
      spy.mockRestore();
    }
  });

  it('deletes the session it created when the start fails', async () => {
    const before = internals.sessions.size;
    const start = vi.spyOn(Session.prototype, 'startInteractive').mockRejectedValue(new Error('cannot start'));
    try {
      const started = await internals.startConversationSession(
        {},
        { workingDir, name: 'Canvas · fail', mode: 'claude', launch: {} }
      );
      expect(started.ok).toBe(false);
      expect(internals.sessions.size).toBe(before);
    } finally {
      start.mockRestore();
    }
  });
});
