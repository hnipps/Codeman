import { modelIdRefusal, type ProviderRow } from '../../../src/canvas/providers.js';

export type { ProviderRow };
/** What the next new conversation starts on. `null` in view state means the person has not chosen. */
export type Choice = { cliId: string | null; model: string };

export type Selection = {
  /** The provider the selector shows: the chosen one, else the first that can start a conversation, else the first listed. */
  row: ProviderRow | undefined;
  /** The chosen provider is no longer listed (disabled or uninstalled since): `alternative` is what to pick instead. */
  stale: boolean;
  alternative: ProviderRow | undefined;
};
/** Resolves a stored choice against the providers the server lists now. Nothing is substituted silently: a stale choice is reported. */
export function selection(rows: readonly ProviderRow[], choice: Choice | null): Selection {
  const first = rows.find((r) => r.available) ?? rows[0];
  if (!choice?.cliId) return { row: first, stale: false, alternative: undefined };
  const row = rows.find((r) => r.id === choice.cliId);
  return row ? { row, stale: false, alternative: undefined } : { row: first, stale: true, alternative: first };
}

export type ModelField = { disabled: boolean; reason: string; invalid: boolean };
/** The model control for a provider: disabled with its reason when the CLI takes no model here, invalid for an id its launch would refuse. */
export function modelField(row: ProviderRow | undefined, model: string): ModelField {
  if (!row) return { disabled: true, reason: '', invalid: false };
  if (!row.model.editable) return { disabled: true, reason: row.model.reason ?? '', invalid: false };
  const refusal = modelIdRefusal(row.model.source, model);
  return { disabled: false, reason: refusal ?? '', invalid: refusal !== undefined };
}

/** The inline line above Send once the choice no longer matches the conversation the rail is bound to. */
export function newConversationNotice(
  bound: { cliId: string; model?: string } | undefined,
  choice: Choice | null,
  sel: Selection
): string {
  if (!bound || !choice || !sel.row) return '';
  const model = choice.model;
  if (sel.row.id === bound.cliId && model === (bound.model ?? '')) return '';
  return `Next message starts a new conversation on ${sel.row.label}${model ? ` · ${model}` : ''}`;
}

/** Suggestions for the model field: models this canvas has already used on that provider. */
export function modelSuggestions(
  conversations: readonly { cliId: string; model?: string }[],
  providerId: string | undefined
): string[] {
  return [...new Set(conversations.flatMap((c) => (c.cliId === providerId && c.model ? [c.model] : [])))].slice(0, 8);
}

/** The model a row of the thread names, with the provider's label: `Codex · gpt-5` or just `Claude`. */
export const agentLabel = (c: { cliId: string; cliLabel?: string; model?: string } | undefined): string =>
  c ? `${c.cliLabel ?? c.cliId}${c.model ? ` · ${c.model}` : ''}` : 'Claude';
