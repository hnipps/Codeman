/**
 * @fileoverview Read My Mind predictor: one-shot `claude -p` over the
 * assembled prediction context (docs/readmymind-plan.md).
 *
 * Runs through `runClaudePrompt()` (claude-prompt.ts: a throwaway tmux
 * session on Codeman's socket, deploy-role checked) rather than AiCheckerBase:
 * the base class is verdict-shaped (positive/negative/cooldown) and prediction
 * is freeform JSON, so subclassing would abuse `reasoning` as a payload.
 *
 * The predictor is deliberately dumb, text in / JSON out; all intelligence
 * about WHAT to include lives in the testable assembler
 * (`readmymind-context.ts`). Output parsing (`parsePredictionOutput`) is pure
 * and strict: garbage output is a clean error, never a half-suggestion, and
 * suggestion prompts are collapsed to single lines server-side (multi-line
 * breaks Ink).
 *
 * Exported as a mutable singleton (`readMyMindPredictor`) so route tests can
 * stub `predict` without spawning anything.
 */

import { z } from 'zod';
import { runClaudePrompt } from './claude-prompt.js';

// ========== Contract ==========

export type SuggestionKind = 'continue' | 'verify' | 'redirect';

export interface ReadMyMindSuggestion {
  /** The proposed next prompt: single line, bounded. */
  prompt: string;
  /** One-sentence rationale. */
  why: string;
  kind: SuggestionKind;
}

export interface PredictionResult {
  suggestions: ReadMyMindSuggestion[];
  durationMs: number;
}

/** Opus headroom over a ~30 KB prompt (decided in the design doc). */
export const READMYMIND_TIMEOUT_MS = 90_000;

const MAX_SUGGESTION_CHARS = 1_000;
const MAX_WHY_CHARS = 300;

/** Lenient on extra keys (zod strips unknowns), strict on shape. */
const SuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        prompt: z.string(),
        why: z.string().optional(),
        kind: z.enum(['continue', 'verify', 'redirect']),
      })
    )
    .min(1)
    .max(3),
});

/** Collapse to one line: embedded newlines break Ink's composer. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * Parse the model's raw output into validated suggestions. Strict by design:
 * anything that does not contain the JSON contract is an Error, never a
 * half-suggestion. Tolerates fenced/prosed wrapping by extracting the
 * outermost object literal before parsing.
 */
export function parsePredictionOutput(raw: string): ReadMyMindSuggestion[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Predictor returned no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Predictor returned malformed JSON');
  }

  const result = SuggestionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Predictor output did not match the suggestions contract');
  }

  const suggestions = result.data.suggestions
    .map((s) => ({
      prompt: singleLine(s.prompt).slice(0, MAX_SUGGESTION_CHARS),
      why: singleLine(s.why ?? '').slice(0, MAX_WHY_CHARS),
      kind: s.kind,
    }))
    .filter((s) => s.prompt.length > 0);

  if (suggestions.length === 0) {
    throw new Error('Predictor returned only empty suggestions');
  }
  return suggestions;
}

// ========== Spawn/poll runner ==========

export interface PredictOptions {
  /** Codeman session id; only its first 8 chars name the throwaway tmux session. */
  sessionId: string;
  /** The assembled context prompt (readmymind-context.ts). */
  prompt: string;
  /** Model name; shell-validated before use. */
  model: string;
  timeoutMs?: number;
}

async function runPrediction(options: PredictOptions): Promise<PredictionResult> {
  const { sessionId, prompt, model } = options;
  const shortId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'rmm';
  const { output, durationMs } = await runClaudePrompt({
    name: `codeman-rmm-${shortId}`,
    prompt,
    model,
    timeoutMs: options.timeoutMs ?? READMYMIND_TIMEOUT_MS,
    label: 'Prediction',
  });
  return { suggestions: parsePredictionOutput(output), durationMs };
}

/**
 * Mutable singleton: routes call `readMyMindPredictor.predict(...)`; tests
 * stub the property (`vi.spyOn(readMyMindPredictor, 'predict')`).
 */
export const readMyMindPredictor = {
  predict: runPrediction,
};
