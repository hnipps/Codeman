/** One send attempt, kept across reloads so a retry reuses the ids and the server writes the prompt once. */
export type Attempt = {
  conversationId: string | null;
  createRequestId: string;
  messageId: string;
  text: string;
  refIds: string[];
};
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
    return o as Attempt;
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
  makeId: () => string
): Attempt {
  if (
    stored &&
    stored.text === text &&
    stored.refIds.length === refIds.length &&
    stored.refIds.every((id, i) => id === refIds[i]) &&
    (stored.conversationId === conversationId || (stored.conversationId !== null && conversationId === null))
  )
    return stored;
  return { conversationId, createRequestId: makeId(), messageId: makeId(), text, refIds };
}
/** Messages the server accepted that this page has not yet seen in the transcript: kept so a failed one can be retried with its own text. */
export function parseSent(raw: string | null): { messageId: string; text: string; refIds: string[] }[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (m): m is { messageId: string; text: string; refIds: string[] } =>
          typeof m === 'object' &&
          m !== null &&
          typeof m.messageId === 'string' &&
          /^[0-9a-fA-F-]{36}$/.test(m.messageId) &&
          typeof m.text === 'string' &&
          Array.isArray(m.refIds) &&
          m.refIds.every((id: unknown) => typeof id === 'string')
      )
      .slice(-10);
  } catch {
    return [];
  }
}
