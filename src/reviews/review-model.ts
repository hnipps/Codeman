/**
 * @fileoverview The Reviews page's stored shape and its rules, with no IO (see `review-store.ts` for the files
 * and `intent/2026-11-16-reviews-page.md` for the design).
 *
 * A review is an agent's walkthrough of one finished branch. A person reads it, leaves notes, and decides. The
 * rules here are the ones both a route and a test must agree on: what an agent may submit, how a resubmission
 * changes an open review, which state a review is in, and the one prompt that carries a person's notes back.
 *
 * Every text an agent supplies is capped and cleaned here, once, so no caller has to remember to.
 */
import { z } from 'zod';
import { ReviewAnchorSchema, MAX_NOTES_PER_SEND } from '../canvas/review-schema.js';

export const MAX_TITLE_CHARS = 140;
export const MAX_WALKTHROUGH_CHARS = 60_000;
export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTES_PER_REVIEW = 300;
export const MAX_REF_CHARS = 200;
export const MAX_PATH_CHARS = 1024;
/** Open reviews one owner may hold; a submit past it is refused, never queued. */
export const MAX_OPEN_REVIEWS = 100;
/** A decided review stays in the queue's "decided" list this long. */
export const DECIDED_VISIBLE_MS = 24 * 60 * 60 * 1000;

const ID = /^[a-z0-9]{8,40}$/;
export const ReviewIdSchema = z.string().regex(ID);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
/** A branch name as git prints it. Validated again by `git check-ref-format` before any git call uses it. */
export const RefSchema = z
  .string()
  .min(1)
  .max(MAX_REF_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((r) => !r.includes('..') && !r.endsWith('/') && !r.endsWith('.lock'), 'Invalid branch name');
const RepoPath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((p) => !p.includes('\0') && !p.startsWith('/') && !p.split('/').includes('..'), 'Invalid path');

const stripControl = (s: string): string =>
  // Tabs and line breaks stay; every other C0 control and DEL goes, so stored text can never drive a terminal.
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
export const cleanLine = (s: string, max: number): string => stripControl(s).replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanText = (s: string, max: number): string => stripControl(s).replace(/\r\n?/g, '\n').slice(0, max);

/**
 * An element of a previewed page, as the frame bridge reported it. Every string here was written by the page inside
 * the frame: it is shown with `textContent` and passes through `cleanLine` before it enters a prompt.
 */
export const PreviewElementSchema = z
  .object({
    /** A CSS selector that found exactly this element when it was picked. */
    selector: z.string().min(1).max(1024),
    /** A readable ancestor trail, such as `main > section.lanes > article.card`. */
    trail: z.string().max(2048).default(''),
    tag: z.string().min(1).max(64),
    text: z.string().max(400).default(''),
    /** Where it was in the frame's viewport when picked, so it can be found again after its selector changes. */
    x: z.number().finite(),
    y: z.number().finite(),
    /** `file:line` when the page marks its elements with one. */
    source: z.string().max(512).optional(),
  })
  .strict();
export type PreviewElement = z.infer<typeof PreviewElementSchema>;

/** Stills one review may carry, and how large each may be. A screenshot of a page is well under this. */
export const MAX_CAPTURES = 24;
export const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
export const CaptureNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
/**
 * A still the agent took of the running branch. The bytes are a file beside the review, named `<name><ext>`;
 * this is what is known about them. `ext` is what the bytes proved to be, never what the upload claimed.
 */
export const CaptureSchema = z
  .object({
    name: CaptureNameSchema,
    ext: z.enum(['.png', '.jpg', '.webp']),
    width: z.number().int().min(1).max(20_000),
    height: z.number().int().min(1).max(20_000),
    bytes: z.number().int().min(1).max(MAX_CAPTURE_BYTES),
    label: z.string().max(80),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type Capture = z.infer<typeof CaptureSchema>;
const Fraction = z.number().min(0).max(1);

export const NoteAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('general') }).strict(),
  z.object({ kind: z.literal('text'), anchor: ReviewAnchorSchema }).strict(),
  z
    .object({
      kind: z.literal('code'),
      path: RepoPath,
      /** 1-based line in the new file, or in the old file when `side` is `old` (a removed line). */
      line: z.number().int().min(1).max(10_000_000),
      side: z.enum(['new', 'old']),
      /** The line's text when the note was written, so the prompt can quote it. */
      text: z.string().max(400),
    })
    .strict(),
  z
    .object({
      kind: z.literal('preview'),
      /** The preview address the reviewer had asked for when the note was written. */
      path: z.string().min(1).max(MAX_PATH_CHARS),
      /** The element on the page the note is about. Absent on a note about the page as a whole. */
      element: PreviewElementSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('capture'),
      name: CaptureNameSchema,
      /** The point the note is about, as fractions of the still's width and height. Absent for the whole still. */
      x: Fraction.optional(),
      y: Fraction.optional(),
    })
    .strict(),
]);
export type NoteAnchor = z.infer<typeof NoteAnchorSchema>;

export const NoteSchema = z
  .object({
    id: ReviewIdSchema,
    at: NoteAnchorSchema,
    text: z.string().min(1).max(MAX_NOTE_CHARS),
    createdAt: z.number().int().nonnegative(),
    sentAt: z.number().int().nonnegative().optional(),
    resolvedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Note = z.infer<typeof NoteSchema>;

/** What happened when a person approved. Absent until then. */
/** A deploy the supervisor neither lists nor runs is given up on after this long. Deploys queue, so it is generous. */
export const DEPLOY_LOST_MS = 45 * 60_000;

export const DecisionSchema = z
  .object({
    kind: z.enum(['merged', 'deploying', 'deployed', 'deploy-failed']),
    at: z.number().int().nonnegative(),
    mergedSha: Sha.optional(),
    deployRequestId: z.string().max(100).optional(),
    error: z.string().max(500).optional(),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export const ReviewSchema = z
  .object({
    id: ReviewIdSchema,
    /** The author session's owner; `null` in single-user mode. */
    owner: z.string().max(200).nullable(),
    sessionId: z.string().min(1).max(100),
    sessionName: z.string().max(200),
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    walkthrough: z.string().max(MAX_WALKTHROUGH_CHARS),
    /** The repository's top level on this machine. Never sent to a browser. */
    repoRoot: z.string().min(1).max(4096),
    /** The folder name shown beside the branch. */
    project: z.string().max(200),
    branch: RefSchema,
    base: RefSchema,
    /** The branch tip when the walkthrough was written. Links are stale once the branch moves past it. */
    headSha: Sha,
    /** How many times the agent has submitted this review. */
    revision: z.number().int().min(1),
    notes: z.array(NoteSchema).max(MAX_NOTES_PER_REVIEW),
    /** Stills of the running branch, for a project whose preview cannot be framed. Absent when there are none. */
    captures: z.array(CaptureSchema).max(MAX_CAPTURES).optional(),
    /** When notes were last sent as Request changes. */
    requestedAt: z.number().int().nonnegative().optional(),
    decision: DecisionSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;

export const ReviewFileSchema = z.object({ version: z.literal(1), review: ReviewSchema }).strict();

export type ReviewState =
  | 'ready'
  | 'changes-requested'
  | 'updated'
  | 'merged'
  | 'deploying'
  | 'deployed'
  | 'deploy-failed';

/** The one word the queue shows. A decision wins; otherwise it turns on whether the agent has answered the notes. */
export function reviewState(r: Review): ReviewState {
  if (r.decision) return r.decision.kind;
  if (r.requestedAt === undefined) return 'ready';
  return r.updatedAt > r.requestedAt ? 'updated' : 'changes-requested';
}
export const isDecided = (r: Review): boolean =>
  r.decision !== undefined && r.decision.kind !== 'deploy-failed' && r.decision.kind !== 'deploying';
export const isOpen = (r: Review): boolean => r.decision === undefined || r.decision.kind === 'deploy-failed';

/** What an agent sends. The server supplies everything else from the session and the repository. */
export const SubmitSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(MAX_TITLE_CHARS * 2),
    walkthrough: z.string().min(1).max(MAX_WALKTHROUGH_CHARS),
    base: RefSchema.optional(),
    /** The stills this revision keeps, by name. Absent keeps them all; the rest are dropped with their files. */
    captures: z.array(CaptureNameSchema).max(MAX_CAPTURES).optional(),
  })
  .strict();
export type Submit = z.infer<typeof SubmitSchema>;

export type RepoFacts = { repoRoot: string; project: string; branch: string; base: string; headSha: string };
export type Author = { owner: string | null; sessionId: string; sessionName: string };

/**
 * A first submission makes a review; a later one from the same session for the same branch replaces the
 * walkthrough of the review that is still open and keeps its notes. A decided review is never reopened.
 */
export function submitReview(
  open: Review | undefined,
  input: Submit,
  facts: RepoFacts,
  author: Author,
  id: string,
  now: number
): Review {
  const title = cleanLine(input.title, MAX_TITLE_CHARS) || 'Untitled review';
  const walkthrough = cleanText(input.walkthrough, MAX_WALKTHROUGH_CHARS);
  if (open) {
    const kept = input.captures ? new Set(input.captures) : null;
    const captures = kept ? (open.captures ?? []).filter((c) => kept.has(c.name)) : open.captures;
    const { captures: _old, ...rest } = open;
    return {
      ...rest,
      ...(captures?.length ? { captures } : {}),
      title,
      walkthrough,
      base: facts.base,
      headSha: facts.headSha,
      sessionName: author.sessionName,
      revision: open.revision + 1,
      // A failed deploy that the agent answers with a new submission is an open review again.
      decision: undefined,
      updatedAt: Math.max(now, open.updatedAt + 1),
    };
  }
  return {
    id,
    ...author,
    title,
    walkthrough,
    ...facts,
    revision: 1,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}
export const sameWork = (r: Review, sessionId: string, facts: RepoFacts): boolean =>
  r.sessionId === sessionId && r.repoRoot === facts.repoRoot && r.branch === facts.branch;

export const NoteBodySchema = z.object({ at: NoteAnchorSchema, text: z.string().min(1).max(MAX_NOTE_CHARS) }).strict();
export const NotePatchSchema = z
  .object({ text: z.string().min(1).max(MAX_NOTE_CHARS).optional(), resolved: z.boolean().optional() })
  .strict();

/** How a deploy this review asked for stands, from the supervisor's own record. Pure. */
export function settledDeploy(
  decision: Decision,
  overview: {
    live: { sha: string } | null;
    recent: {
      sha: string | null;
      action: string;
      outcome: string;
      failedStep: string | null;
      finishedAt: string | null;
    }[];
    busy: boolean;
  },
  now: number
): Decision | null {
  if (decision.kind !== 'deploying' || !decision.mergedSha) return null;
  const sha = decision.mergedSha;
  const run = overview.recent.find((d) => d.action === 'deploy' && d.sha === sha && d.finishedAt !== null);
  if (run?.outcome === 'success' || (!run && overview.live?.sha === sha))
    return { ...decision, kind: 'deployed', at: now };
  if (run)
    return {
      ...decision,
      kind: 'deploy-failed',
      at: now,
      error: cleanLine(
        run.failedStep ? `The deploy failed at ${run.failedStep}` : `The deploy was ${run.outcome}`,
        200
      ),
    };
  const stillListed = overview.recent.some((d) => d.action === 'deploy' && d.sha === sha);
  if (!stillListed && !overview.busy && now - decision.at > DEPLOY_LOST_MS)
    return { ...decision, kind: 'deploy-failed', at: now, error: 'The deploy supervisor has no record of this deploy' };
  return null;
}

/** Records what Approve did. Refused once a review has been approved. */
export function decide(r: Review, decision: Decision): Changed | Refusal {
  if (
    r.decision &&
    !(r.decision.kind === 'deploy-failed' || r.decision.kind === 'deploying' || r.decision.kind === 'merged')
  )
    return refuse('DECIDED', 'DECIDED: this review has been decided');
  if (r.decision && r.decision.mergedSha && decision.mergedSha !== r.decision.mergedSha)
    return refuse('DECIDED', 'DECIDED: this review has been merged');
  return { ok: true, review: { ...r, decision } };
}

export type Refusal = { ok: false; code: 'DECIDED' | 'FULL' | 'NOT_FOUND' | 'SENT'; message: string };
export type Changed = { ok: true; review: Review };
const refuse = (code: Refusal['code'], message: string): Refusal => ({ ok: false, code, message });
const DECIDED = 'DECIDED: this review has been decided; its notes are closed';

export function addNote(r: Review, body: z.infer<typeof NoteBodySchema>, id: string, now: number): Changed | Refusal {
  if (!isOpen(r)) return refuse('DECIDED', DECIDED);
  if (r.notes.length >= MAX_NOTES_PER_REVIEW) return refuse('FULL', 'FULL: this review has too many notes');
  const text = cleanText(body.text, MAX_NOTE_CHARS).trim();
  if (!text) return refuse('NOT_FOUND', 'A note needs some words');
  return { ok: true, review: { ...r, notes: [...r.notes, { id, at: body.at, text, createdAt: now }] } };
}

export function patchNote(
  r: Review,
  noteId: string,
  patch: z.infer<typeof NotePatchSchema>,
  now: number
): Changed | Refusal {
  const note = r.notes.find((n) => n.id === noteId);
  if (!note) return refuse('NOT_FOUND', 'Note not found');
  let next: Note = note;
  if (patch.text !== undefined) {
    // The agent was sent the old words; changing them afterwards would make the record disagree with the prompt.
    if (note.sentAt !== undefined) return refuse('SENT', 'SENT: a note that was sent can be resolved, not edited');
    if (!isOpen(r)) return refuse('DECIDED', DECIDED);
    next = { ...next, text: cleanText(patch.text, MAX_NOTE_CHARS).trim() || note.text };
  }
  if (patch.resolved !== undefined) {
    const { resolvedAt: _drop, ...rest } = next;
    next = patch.resolved ? { ...rest, resolvedAt: note.resolvedAt ?? now } : rest;
  }
  return { ok: true, review: { ...r, notes: r.notes.map((n) => (n.id === noteId ? next : n)) } };
}

export function removeNote(r: Review, noteId: string): Changed | Refusal {
  const note = r.notes.find((n) => n.id === noteId);
  if (!note) return refuse('NOT_FOUND', 'Note not found');
  if (note.sentAt !== undefined) return refuse('SENT', 'SENT: a note that was sent can be resolved, not deleted');
  return { ok: true, review: { ...r, notes: r.notes.filter((n) => n.id !== noteId) } };
}

/** Adds a still, or replaces the one of the same name. Only while the review is open. */
export function putCapture(r: Review, capture: Capture): Changed | Refusal {
  if (!isOpen(r)) return refuse('DECIDED', 'DECIDED: this review has been decided');
  const others = (r.captures ?? []).filter((c) => c.name !== capture.name);
  if (others.length >= MAX_CAPTURES) return refuse('FULL', `FULL: a review carries at most ${MAX_CAPTURES} captures`);
  return { ok: true, review: { ...r, captures: [...others, capture] } };
}
export const captureFile = (c: Pick<Capture, 'name' | 'ext'>): string => `${c.name}${c.ext}`;

export const unsentNotes = (r: Review): Note[] =>
  r.notes.filter((n) => n.sentAt === undefined && n.resolvedAt === undefined);

/** Marks the given notes sent. Only notes still unsent are stamped, so a second press changes nothing. */
export function stampSent(r: Review, noteIds: string[], now: number): Review {
  const ids = new Set(noteIds);
  return {
    ...r,
    requestedAt: now,
    notes: r.notes.map((n) => (ids.has(n.id) && n.sentAt === undefined ? { ...n, sentAt: now } : n)),
  };
}

const oneLine = (s: string, max: number): string => cleanLine(s, max);
const where = (n: Note): string => {
  switch (n.at.kind) {
    case 'general':
      return 'General';
    case 'text':
      return `On your walkthrough, at "${oneLine(n.at.anchor.quote, 160)}"`;
    case 'code':
      return `On ${n.at.path}:${n.at.line}${n.at.side === 'old' ? ' (removed line)' : ''}${
        n.at.text.trim() ? `, \`${oneLine(n.at.text, 160)}\`` : ''
      }`;
    case 'preview': {
      const el = n.at.element;
      if (!el) return `On the preview at ${oneLine(n.at.path, 200)}`;
      const text = oneLine(el.text, 80);
      return [
        `On the preview at ${oneLine(n.at.path, 200)}, the element <${oneLine(el.tag, 64)}>`,
        text ? ` "${text}"` : '',
        ` (selector \`${oneLine(el.selector, 300)}\``,
        el.source ? `, source ${oneLine(el.source, 200)}` : '',
        ')',
      ].join('');
    }
    case 'capture': {
      const { x, y } = n.at;
      const point =
        x === undefined || y === undefined
          ? ''
          : `, at ${Math.round(x * 100)}% across and ${Math.round(y * 100)}% down`;
      return `On the capture "${n.at.name}"${point}`;
    }
  }
};

/**
 * The one prompt that carries a person's notes to the authoring session. The quoted material is the person's own
 * words and text the agent wrote; it is labelled as notes so the agent reads it as a request, not as output.
 */
export function requestChangesPrompt(r: Review, notes: Note[]): { text: string } | { refusal: string } {
  if (!notes.length) return { refusal: 'NOTHING: there is no unsent note to send' };
  if (notes.length > MAX_NOTES_PER_SEND)
    return { refusal: `TOO_MANY: at most ${MAX_NOTES_PER_SEND} notes go in one request; resolve or split them` };
  const lines = [
    `Review notes on "${r.title}" (branch ${r.branch}). The reviewer asked for changes.`,
    '',
    ...notes.flatMap((n, i) => [`${i + 1}. ${where(n)}`, ...n.text.split('\n').map((l) => `   ${l}`), '']),
    'Address each note on the same branch. When you are done, submit the review again with an updated walkthrough',
    '(`codeman agent review submit`). Do not merge or deploy; the reviewer decides.',
  ];
  return { text: lines.join('\n') };
}

/** What a browser gets: everything but the path on this machine. */
export type ReviewView = Omit<Review, 'repoRoot'> & { state: ReviewState; unsent: number };
export function toView(r: Review): ReviewView {
  const { repoRoot: _private, ...rest } = r;
  return { ...rest, state: reviewState(r), unsent: unsentNotes(r).length };
}
export type ReviewSummary = Pick<
  ReviewView,
  'id' | 'title' | 'project' | 'branch' | 'sessionId' | 'sessionName' | 'state' | 'unsent' | 'createdAt' | 'updatedAt'
> & { decidedAt?: number };
export function toSummary(r: Review): ReviewSummary {
  const v = toView(r);
  return {
    id: v.id,
    title: v.title,
    project: v.project,
    branch: v.branch,
    sessionId: v.sessionId,
    sessionName: v.sessionName,
    state: v.state,
    unsent: v.unsent,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    ...(r.decision ? { decidedAt: r.decision.at } : {}),
  };
}

/** The queue: open reviews oldest first (the one waiting longest is at the top), then what was decided lately. */
export function queueOf(all: Review[], now: number): { waiting: ReviewSummary[]; decided: ReviewSummary[] } {
  const waiting = all.filter((r) => !isDecided(r)).sort((a, b) => a.createdAt - b.createdAt);
  const decided = all
    .filter((r) => isDecided(r) && now - (r.decision?.at ?? 0) < DECIDED_VISIBLE_MS)
    .sort((a, b) => (b.decision?.at ?? 0) - (a.decision?.at ?? 0));
  return { waiting: waiting.map(toSummary), decided: decided.map(toSummary) };
}
