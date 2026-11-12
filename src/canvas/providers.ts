/** @fileoverview Which agent CLIs a canvas conversation can start on, and how a chosen model reaches that CLI's launch. Pure: it reads registry entries (data, never a CLI id) and decides; the route supplies the installed set. Shared by the server and the browser. */
import type { CliEntry } from '../config/cli-registry/types.js';

/** The CLI a create request that names none starts on; this is what every conversation used before the choice existed. */
export const DEFAULT_CONVERSATION_CLI = 'claude';
export const MAX_MODEL_ID_LENGTH = 100;

type Capabilities = CliEntry['capabilities'];
export type ModelSource = Capabilities['model']['source'];
/** What lets delivery confirm a message was SUBMITTED, not merely pasted: the CLI's own prompt-submitted hook, or a composer the pane can be read for. */
export type DeliveryEvidence = 'hook' | 'composer' | 'none';

export function deliveryEvidence(
  capabilities: Pick<Capabilities, 'hooks' | 'workDetect' | 'composerReadyMark'>
): DeliveryEvidence {
  if (capabilities.hooks === 'always') return 'hook';
  // The ready mark says the composer painted; the glyph is what `composerIsEmpty()` reads it by. One without the other confirms nothing.
  if (capabilities.workDetect?.promptGlyph && capabilities.composerReadyMark) return 'composer';
  return 'none';
}

export type ProviderModel = { editable: boolean; source: ModelSource; reason?: string };
export type ProviderRow = {
  id: string;
  label: string;
  shortBadge: string;
  available: boolean;
  /** Why a conversation cannot start on this CLI; present exactly when `available` is false. */
  reason?: string;
  model: ProviderModel;
};

/** Where a `flag` CLI takes its model: the legacy config object's key, from registry data. */
function flagTarget(entry: CliEntry): { field: string; key: string } | undefined {
  const field = entry.launch.legacyConfigField;
  if (!field) return undefined;
  const param = entry.capabilities.model.param ?? 'model';
  return { field, key: entry.launch.legacyConfigAliases?.[param] ?? param };
}

export function providerRow(entry: CliEntry): ProviderRow {
  const { model } = entry.capabilities;
  const evidence = deliveryEvidence(entry.capabilities);
  const modelReason =
    model.source === 'none'
      ? `${entry.label} takes its model from its own configuration, so it cannot be chosen here.`
      : model.source === 'flag' && !flagTarget(entry)
        ? `${entry.label} cannot take a model at launch from here.`
        : undefined;
  return {
    id: entry.id as string,
    label: entry.label,
    shortBadge: entry.shortBadge,
    available: evidence !== 'none',
    ...(evidence === 'none'
      ? {
          reason: `${entry.label} gives Codeman no way to confirm a message was submitted, so a conversation cannot start on it yet.`,
        }
      : {}),
    model: {
      editable: modelReason === undefined,
      source: model.source,
      ...(modelReason ? { reason: modelReason } : {}),
    },
  };
}

/** Enabled, installed agent CLIs in registry order. `installed` is the caller's probe; a shell is never an assistant. */
export function providerRows(entries: readonly CliEntry[], installed: (entry: CliEntry) => boolean): ProviderRow[] {
  return entries
    .filter((e) => e.kind === 'agent' && e.enabled && installed(e))
    .sort((a, b) => a.order - b.order)
    .map(providerRow);
}

const CLAUDE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._\-[\]]*$/;
const PLAIN_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/;
/**
 * A model id reaches a command line, so it is held to the narrowest shape the session-create schema accepts
 * for that CLI (claude allows `[1m]` and no slash; the others allow a `provider/model` slash and no brackets).
 * Empty means the CLI's own default and is always fine.
 */
export function modelIdRefusal(source: ModelSource, model: string): string | undefined {
  if (model === '') return undefined;
  if (source === 'none') return 'This CLI takes its model from its own configuration.';
  if (model.length > MAX_MODEL_ID_LENGTH) return `A model id is at most ${MAX_MODEL_ID_LENGTH} characters.`;
  const ok = source === 'claude-settings-file' ? CLAUDE_MODEL.test(model) : PLAIN_MODEL.test(model);
  if (ok) return undefined;
  return source === 'claude-settings-file'
    ? 'A model id starts with a letter or digit and uses only letters, digits and . _ - [ ].'
    : 'A model id starts with a letter or digit and uses only letters, digits and . _ - /.';
}

export type LaunchFields = { ok: true; fields: Record<string, unknown> } | { ok: false; reason: string };
/** The session-create fields that carry the chosen model: claude's per-session `model`, or a flag CLI's own config object. Never `modelOverride`, which rewrites the case's settings file. */
export function launchFields(entry: CliEntry, model: string): LaunchFields {
  if (model === '') return { ok: true, fields: {} };
  const { source } = entry.capabilities.model;
  const refusal = modelIdRefusal(source, model);
  if (refusal) return { ok: false, reason: refusal };
  if (source === 'claude-settings-file') return { ok: true, fields: { model } };
  const target = flagTarget(entry);
  if (!target) return { ok: false, reason: `${entry.label} cannot take a model at launch from here.` };
  return { ok: true, fields: { [target.field]: { [target.key]: model } } };
}
