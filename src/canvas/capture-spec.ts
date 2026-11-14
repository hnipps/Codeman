/**
 * @fileoverview The states spec a prototype capture follows: which web app, at which sizes, and the
 * named states to drive it through, each reached by steps from an earlier state.
 *
 * Pure and declarative. `prototype-capture.ts` runs it in a headless browser on the agent's side (the
 * `codeman mcp` client or `codeman prototype capture`), never inside the Codeman server.
 *
 * A state is reached by replaying its whole chain from a fresh page: the root state's steps, then
 * each descendant's in turn. The first `click` of a state's own steps (or its explicit `hotspot`) is
 * the element on the parent state's page that leads to it, and becomes a hotspot in the prototype.
 */
import { z } from 'zod';

export const CAPTURE_LIMITS = {
  states: 40,
  viewports: 3,
  steps: 50,
  waitMs: 30_000,
  seedEntries: 200,
  seedValueChars: 100_000,
  selectorChars: 512,
  textChars: 10_000,
} as const;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const Name = z
  .string()
  .regex(NAME, 'a name is lower-case letters, digits and dashes, 40 at most, starting with a letter or digit');
const Selector = z.string().min(1).max(CAPTURE_LIMITS.selectorChars);

/** One thing to do on the page. Each step is an object with exactly one action key. */
export const CaptureStepSchema = z.union([
  z.object({ goto: z.string().min(1).max(2048) }).strict(),
  z.object({ click: Selector }).strict(),
  z.object({ type: Selector, text: z.string().max(CAPTURE_LIMITS.textChars) }).strict(),
  z.object({ press: z.string().min(1).max(40) }).strict(),
  z.object({ waitFor: Selector }).strict(),
  z.object({ wait: z.number().int().min(0).max(CAPTURE_LIMITS.waitMs) }).strict(),
]);
export type CaptureStep = z.infer<typeof CaptureStepSchema>;

export const CaptureViewportSchema = z
  .object({
    name: Name,
    width: z.number().int().min(240).max(3840),
    height: z.number().int().min(240).max(3840),
    /** Emulate a phone: touch, mobile meta viewport. */
    mobile: z.boolean().default(false),
    deviceScaleFactor: z.number().min(1).max(3).default(1),
    /** The browser's user agent; a phone viewport sends an iPhone Safari one by default. */
    userAgent: z.string().min(1).max(512).optional(),
  })
  .strict();
export type CaptureViewport = z.infer<typeof CaptureViewportSchema>;

export const CaptureStateSchema = z
  .object({
    name: Name,
    /** Shown in the state switcher; the name by default. */
    label: z.string().trim().min(1).max(80).optional(),
    /** The state this one starts from. Absent for a root state, which starts from a fresh page. */
    from: Name.optional(),
    steps: z.array(CaptureStepSchema).max(CAPTURE_LIMITS.steps).default([]),
    /**
     * The element on the `from` page that leads here. Defaults to the selector of the first `click`
     * step; `false` makes no hotspot (reach the state from the switcher only).
     */
    hotspot: z.union([Selector, z.literal(false)]).optional(),
    /** The viewports this state exists at (a dialog only a laptop shows); every viewport by default. */
    viewports: z.array(Name).min(1).max(CAPTURE_LIMITS.viewports).optional(),
  })
  .strict();
export type CaptureState = z.infer<typeof CaptureStateSchema>;

export const CaptureSpecSchema = z
  .object({
    /** The running app, http or https. Every `goto` resolves against it and must stay on its origin. */
    baseUrl: z.string().url().max(2048),
    viewports: z
      .array(CaptureViewportSchema)
      .min(1)
      .max(CAPTURE_LIMITS.viewports)
      .default([{ name: 'desktop', width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 }]),
    /** localStorage entries set on the app's origin before the first page of each state loads. */
    localStorage: z
      .record(z.string().min(1).max(256), z.string().max(CAPTURE_LIMITS.seedValueChars))
      .refine(
        (r) => Object.keys(r).length <= CAPTURE_LIMITS.seedEntries,
        `At most ${CAPTURE_LIMITS.seedEntries} entries`
      )
      .default({}),
    /** Milliseconds to let a state settle after its last step, before it is saved. */
    settleMs: z.number().int().min(0).max(CAPTURE_LIMITS.waitMs).default(400),
    /** Add the state switcher to every page. */
    switcher: z.boolean().default(true),
    states: z.array(CaptureStateSchema).min(1).max(CAPTURE_LIMITS.states),
  })
  .strict();
export type CaptureSpec = z.infer<typeof CaptureSpecSchema>;

export class CaptureSpecError extends Error {}

/** One transition the prototype can follow: a click on `selector` in `from` opens `to`. */
export interface CaptureHotspot {
  from: string;
  to: string;
  selector: string;
}

/** The hotspot that leads to a state, or null when it has none. */
export function hotspotFor(state: CaptureState): CaptureHotspot | null {
  if (!state.from || state.hotspot === false) return null;
  const selector =
    state.hotspot ?? state.steps.find((step): step is { click: string } => 'click' in step)?.click ?? null;
  return selector ? { from: state.from, to: state.name, selector } : null;
}

/** The steps that reach a state from a fresh page, root first. */
export function stepsToReach(spec: CaptureSpec, name: string): CaptureStep[] {
  const byName = new Map(spec.states.map((s) => [s.name, s]));
  const chain: CaptureState[] = [];
  for (let at = byName.get(name); at; at = at.from ? byName.get(at.from) : undefined) chain.unshift(at);
  const steps = chain.flatMap((s) => s.steps);
  // A root with no goto opens the base URL itself.
  return steps.length && 'goto' in steps[0] ? steps : [{ goto: '/' }, ...steps];
}

/**
 * Parse and check a spec: names unique, every `from` names an EARLIER state (so there are no cycles
 * and the order in the file is a valid capture order), and every `goto` stays on the base origin.
 * Throws `CaptureSpecError` with a sentence naming the field.
 */
export function parseCaptureSpec(input: unknown): CaptureSpec {
  const parsed = CaptureSpecSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CaptureSpecError(`Capture spec: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const spec = parsed.data;
  const base = new URL(spec.baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:')
    throw new CaptureSpecError('Capture spec: baseUrl must be an http or https address');
  const seenViewports = new Set<string>();
  for (const viewport of spec.viewports) {
    if (seenViewports.has(viewport.name))
      throw new CaptureSpecError(`Capture spec: viewport "${viewport.name}" is listed twice`);
    seenViewports.add(viewport.name);
  }
  const seen = new Set<string>();
  const at = new Map<string, Set<string>>();
  for (const state of spec.states) {
    if (seen.has(state.name)) throw new CaptureSpecError(`Capture spec: state "${state.name}" is listed twice`);
    if (state.from !== undefined && !seen.has(state.from))
      throw new CaptureSpecError(
        `Capture spec: state "${state.name}" starts from "${state.from}", which is not an earlier state`
      );
    for (const step of state.steps)
      if ('goto' in step) {
        let target: URL;
        try {
          target = new URL(step.goto, base);
        } catch {
          throw new CaptureSpecError(`Capture spec: state "${state.name}": ${step.goto} is not an address`);
        }
        if (target.origin !== base.origin)
          throw new CaptureSpecError(
            `Capture spec: state "${state.name}": goto ${step.goto} leaves ${base.origin}; a capture stays on the base URL's origin`
          );
      }
    const where = new Set(state.viewports ?? spec.viewports.map((v) => v.name));
    for (const name of where)
      if (!seenViewports.has(name))
        throw new CaptureSpecError(
          `Capture spec: state "${state.name}" names viewport "${name}", which the spec does not list`
        );
    if (state.from !== undefined)
      for (const name of where)
        if (!at.get(state.from)?.has(name))
          throw new CaptureSpecError(
            `Capture spec: state "${state.name}" is captured at ${name}, where "${state.from}" is not`
          );
    at.set(state.name, where);
    seen.add(state.name);
  }
  if (!at.get(spec.states[0].name)?.has(spec.viewports[0].name))
    throw new CaptureSpecError('Capture spec: the first state must exist at the first viewport; it is the entry page');
  return spec;
}

/** Whether a state is captured at a viewport. */
export const stateAt = (state: CaptureState, viewport: string): boolean =>
  !state.viewports || state.viewports.includes(viewport);

/** The file of one state at one viewport, relative to the prototype root. */
export const statePagePath = (viewport: string, state: string): string => `${viewport}/${state}.html`;
