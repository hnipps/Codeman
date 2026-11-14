import { z } from 'zod';
import { ElementRefSchema, MAX_ELEMENT_REFS, type ElementRef } from '../../../src/canvas/element-ref.js';

/** One send attempt, kept across reloads so a retry reuses the ids and the server writes the prompt once. */
export type Attempt = {
  conversationId: string | null;
  createRequestId: string;
  messageId: string;
  text: string;
  refIds: string[];
  /** Elements picked inside frames that ride with the message; absent in an attempt an earlier page stored. */
  elements?: ElementRef[];
};
const ElementsSchema = z.array(ElementRefSchema).max(MAX_ELEMENT_REFS);
/** Stored elements read back: anything that is not a bounded list of well-formed elements reads as none. */
export function parseElements(raw: unknown): ElementRef[] {
  const parsed = ElementsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}
/** The `elements` field of a send: present only when the message carries some, so a plain message is unchanged on the wire. */
export const elementsField = (elements: ElementRef[] | undefined): { elements?: ElementRef[] } =>
  elements?.length ? { elements } : {};
const sameElements = (a: ElementRef[], b: ElementRef[]): boolean =>
  a.length === b.length && a.every((ref, i) => ref.objectId === b[i].objectId && ref.selector === b[i].selector);
export function parseAttempt(raw: string | null): Attempt | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    const uuid = /^[0-9a-fA-F-]{36}$/;
    if (
      typeof o.text !== 'string' ||
      typeof o.messageId !== 'string' ||
      !uuid.test(o.messageId) ||
      typeof o.createRequestId !== 'string' ||
      !uuid.test(o.createRequestId) ||
      !Array.isArray(o.refIds) ||
      !o.refIds.every((id) => typeof id === 'string') ||
      (o.conversationId !== null && typeof o.conversationId !== 'string')
    )
      return null;
    const { elements: _stored, ...rest } = o as Attempt;
    return { ...rest, ...elementsField(parseElements(o.elements)) };
  } catch {
    return null;
  }
}
/** The same message again reuses its ids; any change to the text, the context or the conversation is a new message. */
export function nextAttempt(
  stored: Attempt | null,
  conversationId: string | null,
  text: string,
  refIds: string[],
  makeId: () => string,
  elements: ElementRef[] = []
): Attempt {
  if (
    stored &&
    stored.text === text &&
    stored.refIds.length === refIds.length &&
    stored.refIds.every((id, i) => id === refIds[i]) &&
    sameElements(stored.elements ?? [], elements) &&
    (stored.conversationId === conversationId || (stored.conversationId !== null && conversationId === null))
  )
    return stored;
  return { conversationId, createRequestId: makeId(), messageId: makeId(), text, refIds, ...elementsField(elements) };
}
/** Messages the server accepted that this page has not yet seen in the transcript: kept so a failed one can be retried with its own text. */
export type SentRecord = { messageId: string; text: string; refIds: string[]; elements?: ElementRef[] };
export function parseSent(raw: string | null): SentRecord[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (m): m is SentRecord =>
          typeof m === 'object' &&
          m !== null &&
          typeof m.messageId === 'string' &&
          /^[0-9a-fA-F-]{36}$/.test(m.messageId) &&
          typeof m.text === 'string' &&
          Array.isArray(m.refIds) &&
          m.refIds.every((id: unknown) => typeof id === 'string')
      )
      .map((m) => ({
        messageId: m.messageId,
        text: m.text,
        refIds: m.refIds,
        ...elementsField(parseElements(m.elements)),
      }))
      .slice(-10);
  } catch {
    return [];
  }
}
