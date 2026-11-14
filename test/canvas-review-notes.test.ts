/**
 * Review notes on a canvas text object, server side: the side file (round trip, bounds, an unreadable file left
 * alone, the previous release still reads the state), anchoring (relocation, text changed, the Answer rule), and
 * Send (one prompt for every unsent note, stamped once; a failed send stamps nothing; a person only).
 *
 * Port: N/A (app.inject).
 */
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { readReviewNotes, reviewNotesPath, reviewPrompt, setReviewNote } from '../src/canvas/review-notes.js';
import { MAX_NOTES_PER_SEND, MAX_REVIEW_NOTES, noteState, type ReviewNote } from '../src/canvas/review-schema.js';
import { anchorFromOffsets, answerAnchor, isQuestionLine, locate } from '../src/canvas/review-anchor.js';
import { deployRole } from '../src/deploy-role.js';
import { resolveCasePath } from '../src/web/routes/case-routes.js';
import * as previous from './fixtures/canvas-model-previous.js';
import { human } from './canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-review-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const uuid = () => crypto.randomUUID();
const BRIEF = 'Prototypes of Codeman\n1. Which surface comes first?\nThe rail is narrow. The rail opens on the right.';
const brief = (text = BRIEF) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-brief`,
    objectId: 'brief',
    patch: {
      parentId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 },
      content: { type: 'text', text },
    },
  });
const anchorOf = (quote: string, text = BRIEF) => {
  const at = text.indexOf(quote);
  return anchorFromOffsets(text, at, at + quote.length)!;
};

async function harness(options: { writeOk?: boolean } = {}) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'admin', role: 'admin' };
  });
  const workspace = workspaceForCase('review-case', undefined);
  const sessions = new Map<string, Record<string, unknown>>();
  const writeViaMux = vi.fn(async () => options.writeOk ?? true);
  sessions.set('writer', { id: 'writer', workingDir: dir, writeViaMux });
  const stores = new CanvasStores();
  const port = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
  };
  registerCanvasRoutes(app, port as never);
  installRouteErrorHandler(app);
  await app.ready();
  const base = `/api/canvas/${workspace.id}`;
  const store = stores.get(workspace.id);
  store.append([brief()], { kind: 'agent', sessionId: 'writer' });
  const comment = async (text: string, id = uuid()) => {
    const r = await app.inject({
      method: 'POST',
      url: `${base}/command`,
      payload: { tool: 'canvas_comment', requestId: uuid(), arguments: { objectId: 'brief', text, commentId: id } },
    });
    expect(r.statusCode).toBe(200);
    return id;
  };
  const setNote = (id: string, note: unknown, resolved?: boolean) =>
    app.inject({
      method: 'PUT',
      url: `${base}/review-notes/${id}`,
      payload: { note, ...(resolved === undefined ? {} : { resolved }) },
    });
  const notes = async () =>
    (await app.inject({ url: `${base}/review-notes` })).json().data.notes as Record<string, ReviewNote>;
  const send = (commentIds: string[], extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `${base}/review/brief/send`, payload: { commentIds, ...extra } });
  return { app, port, workspace, store, sessions, writeViaMux, comment, setNote, notes, send };
}

describe('review anchoring', () => {
  it('relocates a quote after an edit, prefers the occurrence with matching surroundings, and reports gone words', () => {
    const anchor = anchorOf('The rail opens');
    expect(anchor).toEqual({
      quote: 'The rail opens',
      prefix: expect.stringMatching(/narrow\. $/),
      suffix: ' on the right.',
    });
    const edited = `Intro line added.\n${BRIEF}`;
    const at = locate(edited, anchor)!;
    expect(edited.slice(at.start, at.end)).toBe('The rail opens');
    // "The rail" occurs twice; the one whose suffix matches wins.
    const second = anchorOf('The rail opens'.slice(0, 8), BRIEF.replace('The rail is', 'XXXXXXXXXXX'));
    expect(second.quote).toBe('The rail');
    expect(locate(BRIEF, { quote: 'The rail', prefix: 'narrow. ', suffix: ' opens' })!.start).toBe(
      BRIEF.indexOf('The rail opens')
    );
    expect(locate(BRIEF.replace('The rail opens', 'It opens'), anchor)).toBeNull();
    expect(anchorFromOffsets(BRIEF, 3, 3)).toBeNull();
    expect(anchorFromOffsets('   ', 0, 3)).toBeNull();
  });

  it('offers Answer only within one numbered line ending in a question mark', () => {
    expect(isQuestionLine('1. Which surface comes first?')).toBe(true);
    expect(isQuestionLine('2) Why?  ')).toBe(true);
    expect(isQuestionLine('Which surface comes first?')).toBe(false);
    expect(isQuestionLine('1. A statement.')).toBe(false);
    const at = BRIEF.indexOf('surface');
    expect(answerAnchor(BRIEF, at, at + 7)?.quote).toBe('1. Which surface comes first?');
    // A selection that runs past the question's line is not an answer.
    expect(answerAnchor(BRIEF, at, BRIEF.indexOf('narrow'))).toBeNull();
    const plain = BRIEF.indexOf('narrow');
    expect(answerAnchor(BRIEF, plain, plain + 6)).toBeNull();
  });
});

describe('review notes side file', () => {
  it('round-trips a note, keeps the server stamps, resolves only on request, and writes 0600 on the live colour only', async () => {
    const h = await harness();
    try {
      const id = await h.comment('Replace “narrow” with “wide”.');
      const note = { kind: 'replace', anchor: anchorOf('narrow'), replacement: 'wide' };
      expect((await h.setNote(id, note)).statusCode).toBe(200);
      expect(await h.notes()).toEqual({ [id]: note });
      expect(statSync(reviewNotesPath(h.workspace.id)).mode & 0o777).toBe(0o600);
      expect(h.port.broadcast).toHaveBeenCalledWith(
        'canvas:changed',
        expect.objectContaining({ workspaceId: h.workspace.id, reviewNotes: true })
      );
      expect((await h.setNote(id, note, true)).statusCode).toBe(200);
      const resolved = (await h.notes())[id]!;
      expect(noteState(resolved)).toBe('resolved');
      // Editing the note again keeps its resolved stamp unless the page says otherwise.
      await h.setNote(id, { ...note, replacement: 'wider' });
      expect((await h.notes())[id]).toEqual({ ...note, replacement: 'wider', resolvedAt: resolved.resolvedAt });
      await h.setNote(id, note, false);
      expect(noteState((await h.notes())[id]!)).toBe('unsent');
      // A page cannot stamp a send, and Replace without new words is refused.
      expect((await h.setNote(id, { ...note, sentAt: 1 })).statusCode).toBe(400);
      expect((await h.setNote(id, { kind: 'replace', anchor: note.anchor })).statusCode).toBe(400);
      expect((await h.setNote(id, { kind: 'general', anchor: note.anchor })).statusCode).toBe(400);
      // Only a comment that is on a text object can carry a note.
      expect((await h.setNote(uuid(), { kind: 'general' })).statusCode).toBe(409);
      deployRole.enter('retired');
      const before = readFileSync(reviewNotesPath(h.workspace.id), 'utf8');
      expect((await h.setNote(id, { kind: 'general' })).statusCode).toBe(409);
      expect(readFileSync(reviewNotesPath(h.workspace.id), 'utf8')).toBe(before);
    } finally {
      await h.app.close();
    }
  });

  it('hides a note whose comment is removed and leaves a file of another release untouched', async () => {
    const h = await harness();
    try {
      const id = await h.comment('A general note');
      await h.setNote(id, { kind: 'general' });
      const removed = await h.app.inject({
        method: 'POST',
        url: `/api/canvas/${h.workspace.id}/command`,
        payload: {
          tool: 'canvas_update',
          requestId: uuid(),
          arguments: { operations: [{ kind: 'remove-comment', opId: uuid(), objectId: 'brief', patch: { id } }] },
        },
      });
      expect(removed.statusCode).toBe(200);
      expect(await h.notes()).toEqual({});

      const later = JSON.stringify({ version: 2, notes: { x: { kind: 'poll' } } });
      writeFileSync(reviewNotesPath(h.workspace.id), later);
      const other = await h.comment('Another');
      expect(await h.notes()).toEqual({});
      expect((await h.setNote(other, { kind: 'general' })).statusCode).toBe(409);
      expect(readFileSync(reviewNotesPath(h.workspace.id), 'utf8')).toBe(later);
      // An entry this release cannot read is left out, and a key it does not know is carried over on a write.
      writeFileSync(
        reviewNotesPath(h.workspace.id),
        JSON.stringify({ version: 1, extra: 'kept', notes: { [other]: { kind: 'poll' } } })
      );
      expect(await h.notes()).toEqual({});
      await h.setNote(other, { kind: 'general' });
      expect(JSON.parse(readFileSync(reviewNotesPath(h.workspace.id), 'utf8'))).toEqual({
        version: 1,
        extra: 'kept',
        notes: { [other]: { kind: 'general' } },
      });
    } finally {
      await h.app.close();
    }
  });

  it('bounds the file, dropping notes of removed comments first and never the one being written', async () => {
    const h = await harness();
    try {
      const keep = await h.comment('kept');
      const state = h.store.read();
      const entries: Record<string, ReviewNote> = {};
      for (let i = 0; i < MAX_REVIEW_NOTES; i++) entries[`gone-${i}`] = { kind: 'general' };
      writeFileSync(reviewNotesPath(h.workspace.id), JSON.stringify({ version: 1, notes: entries }));
      expect(setReviewNote(h.workspace.id, state, keep, { note: { kind: 'general' } }, 1)).toBe('ok');
      const stored = JSON.parse(readFileSync(reviewNotesPath(h.workspace.id), 'utf8')).notes;
      expect(Object.keys(stored)).toHaveLength(MAX_REVIEW_NOTES);
      expect(stored[keep]).toEqual({ kind: 'general' });
      expect(stored['gone-0']).toBeUndefined();
      expect(readReviewNotes(h.workspace.id, state)).toEqual({ [keep]: { kind: 'general' } });
    } finally {
      await h.app.close();
    }
  });

  it('adds no key the previous release cannot parse: the state, comments and objects stay as it reads them', async () => {
    const h = await harness();
    try {
      const id = await h.comment('Delete “narrow”.');
      await h.setNote(id, { kind: 'delete', anchor: anchorOf('narrow') });
      expect(previous.StateSchema.safeParse(h.store.read()).success).toBe(true);
    } finally {
      await h.app.close();
    }
  });
});

describe('sending review notes', () => {
  it('sends every unsent note in one prompt to the writer, stamps exactly those, and never sends one twice', async () => {
    const h = await harness();
    try {
      const a = await h.comment('Replace “narrow” with “wide”. Wider reads better.');
      await h.setNote(a, { kind: 'replace', anchor: anchorOf('narrow'), replacement: 'wide' });
      const b = await h.comment('We start with the rail.');
      await h.setNote(b, { kind: 'answer', anchor: anchorOf('1. Which surface comes first?') });
      const c = await h.comment('Resolved already');
      await h.setNote(c, { kind: 'general' }, true);
      const sent = await h.send([a, b, c]);
      expect(sent.statusCode).toBe(200);
      expect(sent.json().data.sent).toEqual([a, b]);
      expect(h.writeViaMux).toHaveBeenCalledTimes(1);
      const prompt = String(h.writeViaMux.mock.calls[0]![0]);
      expect(prompt).toContain('object id brief');
      expect(prompt).toContain('1. Replace on "narrow"');
      expect(prompt).toContain('Replace with: "wide"');
      expect(prompt).toContain('2. Answer on "1. Which surface comes first?"');
      expect(prompt).not.toContain('Resolved already');
      const notes = await h.notes();
      expect(noteState(notes[a]!)).toBe('sent');
      expect(noteState(notes[b]!)).toBe('sent');
      expect(notes[c]!.sentAt).toBeUndefined();
      // The same press again finds nothing unsent.
      const again = await h.send([a, b]);
      expect(again.statusCode).toBe(409);
      expect(h.writeViaMux).toHaveBeenCalledTimes(1);
    } finally {
      await h.app.close();
    }
  });

  it('stamps nothing when the prompt could not be written', async () => {
    const h = await harness({ writeOk: false });
    try {
      const a = await h.comment('A note');
      await h.setNote(a, { kind: 'general' });
      const sent = await h.send([a]);
      expect(sent.statusCode).toBe(409);
      expect(sent.json().error).toContain('NOT_WRITTEN');
      expect((await h.notes())[a]!.sentAt).toBeUndefined();
    } finally {
      await h.app.close();
    }
  });

  it('says a note whose words are gone is about words no longer in the text', async () => {
    const h = await harness();
    try {
      const a = await h.comment('Delete “narrow”.');
      await h.setNote(a, { kind: 'delete', anchor: anchorOf('narrow') });
      const edited = CommandSchema.parse({
        kind: 'update',
        opId: uuid(),
        objectId: 'brief',
        patch: { content: { type: 'text', text: BRIEF.replace('narrow', 'wide') } },
      });
      h.store.append([edited], human);
      expect((await h.send([a])).statusCode).toBe(200);
      expect(String(h.writeViaMux.mock.calls[0]![0])).toContain('(these words are no longer in the text)');
    } finally {
      await h.app.close();
    }
  });

  it('refuses when the writer has ended unless the person picks a running session, and refuses an agent caller', async () => {
    const h = await harness();
    try {
      const a = await h.comment('A note');
      await h.setNote(a, { kind: 'general' });
      h.sessions.get('writer')!.paneExit = { status: 0 };
      const refused = await h.send([a]);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain('SESSION_ENDED');
      expect((await h.send([a], { sessionId: 'elsewhere' })).statusCode).toBe(409);
      const writeOther = vi.fn(async () => true);
      h.sessions.set('other', {
        id: 'other',
        workingDir: await resolveCasePath('review-case'),
        writeViaMux: writeOther,
      });
      const picked = await h.send([a], { sessionId: 'other' });
      expect(picked.statusCode).toBe(200);
      expect(writeOther).toHaveBeenCalledTimes(1);
      const agent = await h.app.inject({
        method: 'POST',
        url: `/api/canvas/current/review/brief/send`,
        headers: { 'x-codeman-parent-session': 'other' },
        payload: { commentIds: [a] },
      });
      expect([400, 403]).toContain(agent.statusCode);
    } finally {
      await h.app.close();
    }
  });

  it('refuses more notes than one prompt carries', () => {
    const notes = Array.from({ length: MAX_NOTES_PER_SEND + 1 }, (_, i) => ({
      commentId: `n${i}`,
      note: { kind: 'general' } as ReviewNote,
      text: 'x',
      located: true,
    }));
    expect(reviewPrompt({ id: 'brief', label: 'Brief' }, notes)).toEqual({
      refusal: expect.stringContaining('at most'),
    });
    expect(reviewPrompt({ id: 'brief', label: 'Brief' }, [])).toEqual({ refusal: expect.any(String) });
    const tabbed = reviewPrompt({ id: 'brief', label: 'A\tB' }, [
      { commentId: 'x', note: { kind: 'general' }, text: 'line one\nline\ttwo', located: true },
    ]);
    expect('text' in tabbed && tabbed.text).toContain('Note: line one line two');
  });
});
