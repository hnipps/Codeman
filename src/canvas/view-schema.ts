/** @fileoverview Pure shapes of a canvas view: what a browser tab publishes and what an agent may ask it to do. Shared by the server registry and the browser. */
import { z } from 'zod';
import { IdSchema } from './model.js';
import { ElementRefSchema, MAX_ELEMENT_REFS } from './element-ref.js';

/** One view publishes at most this often, so a pan cannot flood the server. */
export const MIN_PUBLISH_GAP_MS = 250;
export const RAIL_VIEWS = ['keys', 'reader', 'thread', 'history', 'assistant', 'tasks', 'page'] as const;
/** Where one embed's live page can be shown besides its place on the board: docked in the right rail, or over the whole canvas. */
export const PAGE_SLOTS = ['rail', 'full'] as const;
export type PageSlot = (typeof PAGE_SLOTS)[number];
const ViewportSchema = z
  .object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) })
  .strict();
export const MAX_VIEW_IDS = 200;
const Ids = z.array(IdSchema).min(1).max(MAX_VIEW_IDS);
/** The assistant's provider and model for the NEXT new conversation. `cliId: null` is the first available provider; an empty model is the CLI's own default. */
export const AssistantChoiceSchema = z
  .object({ cliId: z.string().min(1).max(64).nullable(), model: z.string().max(100) })
  .strict();
export type AssistantChoice = z.infer<typeof AssistantChoiceSchema>;
/** The state one canvas tab reports. It is ephemeral and never written to disk. */
export const PublishedViewSchema = z
  .object({
    viewport: ViewportSchema,
    selected: z.array(IdSchema).max(1000),
    focusId: IdSchema.nullable(),
    rail: z.array(z.enum(RAIL_VIEWS)).max(8),
    context: z.array(IdSchema).max(MAX_VIEW_IDS),
    /** Elements inside live frames waiting to go with the next message; absent from an earlier page. A person's alone: no view command changes it. */
    contextElements: z.array(ElementRefSchema).max(MAX_ELEMENT_REFS).optional(),
    conversationId: z.string().max(128).nullable(),
    root: IdSchema.nullable(),
    letters: z.boolean(),
    draftBytes: z.number().int().min(0).max(100_000_000),
    phone: z.boolean(),
    /** The provider and model the next new conversation starts on; absent from a page of an earlier release. */
    choice: AssistantChoiceSchema.optional(),
    /** The session whose terminal covers this canvas as a full view (PC13); absent from an earlier page. */
    fullView: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .nullable()
      .optional(),
    /** The embed each page slot shows, or null; absent from an earlier page. `full` is null while a session's terminal has the full view. */
    pages: z.object({ rail: IdSchema.nullable(), full: IdSchema.nullable() }).strict().optional(),
    appliedCommands: z.array(z.uuid()).max(20),
    /** The latest command this view refused, and why in plain words; absent when the latest one was applied. */
    refused: z
      .object({ commandId: z.uuid(), reason: z.string().min(1).max(200) })
      .strict()
      .optional(),
  })
  .strict();
export type PublishedView = z.infer<typeof PublishedViewSchema>;
export const ViewActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set-viewport'), viewport: ViewportSchema }).strict(),
  z.object({ action: z.literal('fit'), targetIds: Ids.optional() }).strict(),
  z.object({ action: z.literal('select'), targetIds: Ids }).strict(),
  z.object({ action: z.literal('clear-selection') }).strict(),
  z.object({ action: z.literal('focus'), targetId: IdSchema.nullable() }).strict(),
  z.object({ action: z.literal('rail'), view: z.enum(RAIL_VIEWS), open: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal('letters'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('context-add'), targetIds: Ids }).strict(),
  z.object({ action: z.literal('context-remove'), targetIds: Ids }).strict(),
  z.object({ action: z.literal('assistant-choice'), ...AssistantChoiceSchema.shape }).strict(),
  /** Open a listed session's terminal over the canvas, or close it with `sessionId: null`. Shell pages only. */
  z
    .object({
      action: z.literal('full-view'),
      sessionId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .nullable(),
    })
    .strict(),
  /** Show one live embed's page in the rail or over the whole canvas. Laptop views only; it takes no keystroke. */
  z.object({ action: z.literal('open-page'), objectId: IdSchema, slot: z.enum(PAGE_SLOTS) }).strict(),
  z.object({ action: z.literal('close-page'), slot: z.enum(PAGE_SLOTS) }).strict(),
]);
export type ViewAction = z.infer<typeof ViewActionSchema>;
/** What the server broadcasts to the tab that owns `viewId`. */
export const ViewCommandEventSchema = z
  .object({
    workspaceId: z.string(),
    viewId: z.uuid(),
    commandId: z.uuid(),
    owner: z.string().optional(),
    command: ViewActionSchema,
  })
  .strict();
export type ViewCommandEvent = z.infer<typeof ViewCommandEventSchema>;
