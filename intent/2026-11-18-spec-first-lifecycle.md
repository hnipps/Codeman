# Intent: Spec-first work lifecycle

**Status:** Draft (brief approved by the owner 2026-11-18, canvas object `spec-first-lifecycle-brief`, r3)

## Problem statement

Every Ready Work item goes to routine R-2, which builds it, opens a PR and asks the owner "PR is ready for your review and merge". The owner is the only gate, and the gate sits at the end, where every decision is already made and changing one is expensive. There is no gate before work starts and no agent gate after it.

## Proposed outcome

The owner's gate moves to the start. The owner approves specs and designs. Agents build, review and ship what those specs cover, and escalate only what the specs do not cover.

1. A feature item in Needs refinement gets a **spec** drafted by an agent. A spec has outcomes, constraints, invariants (each phrased so a test can pin it), non-goals, acceptance checks, design links (canvas prototypes for UI/UX), a technical design (data shape, modules touched, risks) and a ticket breakdown (titles, order, dependencies). The breakdown is collapsed by default and stored in the same file.
2. The spec appears on the Reviews page as a **Spec review**: the document with anchored notes, and its prototypes in the stage. A single Approve covers the spec and its breakdown, and the spec merges. The agent then files the tickets as children of the spec item, in Ready.
3. R-2 builds each ticket. **R-3**, a separate reviewer routine in a different session from the builder, checks the ticket against the spec. R-3 works in poteto-mode, reading its SKILL.md as R-2 does, and uses the crosscheck skills: audit-spec-coverage, intent-check, and reason or trace-execution. A crosscheck finding feeds R-3's judgment and never escalates on its own.
4. Once R-3 passes a ticket, it merges and deploys through `codeman-deploy`. The ticket gets a line in the spec's read-only **Shipped** log, which records the PR, R-3's verdict and any **Deviations**.
5. When a deploy fails or is rolled back, agents fix it. The owner is told through a notice and a Shipped-log entry, but is not asked to act. It escalates only if the fix fails or the fix trips another trigger.
6. **Spirit of the spec.** The builder may change anything that keeps the outcomes, constraints and invariants intact, and lists each change as a Deviation. The escalation triggers are a fixed list:
   - an outcome is dropped or changed
   - a constraint or invariant is broken
   - something the owner sees or uses changes in a way the spec did not describe
   - the work outgrows its ticket
   - builder and R-3 still disagree after 2 rounds
   - the work cannot be verified
   - a deploy fix fails or trips a trigger

   Style, naming, how the work is split, and wording the spec did not pin down are not triggers.
7. An escalation appears on the Reviews page with its reason at the top. Its verdicts are Approve (ship anyway), Request changes (back to the builder) and New spec (an agent drafts a superseding spec).
8. Small fixes skip the spec gate. A bug or chore that can be described precisely goes straight to Ready and then through R-2 and R-3. Anything borderline is flagged to the owner.

## Specs are files

- One version-controlled file per spec (for example `intent/<date>-<slug>.md`), on a docs branch until approval. Revisions before approval edit that same file.
- **Immutable once merged.** A merged spec file is never edited, not even to append to it. A change is a new spec file with a `Supersedes:` line naming the spec or specs it changes, and it goes through a Spec review. Links run from the new spec to the old one. The Reviews page and the Work item follow these links to show the chain. R-3 refuses any change to a merged spec file; a CI or pre-push check is added only if the pilot shows it is needed.

## Affected users and systems

- The owner, on the Reviews page (desktop and phone) and the canvas Work view.
- Routines R-1 (Repo Assist), R-2 (Build) and a new R-3 (Review).
- `src/canvas/work.ts` and `work-store.ts` (spec item kind, parent link, deviations on the report), `src/reviews/*`, `routes/review-routes.ts`, `reviews.{html,js,css}`, MCP `canvas_work`.
- `PRODUCT.md`: the principle is rewritten in this change to "Nothing is merged or deployed without a person's approval of the spec that authorises it" (owner sign-off 2026-11-18).

## Constraints

- Owner decisions, 2026-11-18:
  - agent-approved work merges and deploys
  - features need a spec, and precise small fixes do not
  - specs are reviewed on the Reviews page
  - one Approve covers a spec and its breakdown
  - "spirit of the spec" latitude
  - finished-work reviews become the escalation lane
  - the reviewer is a separate routine (R-3)
  - merged specs are immutable
- Self-building rule 5: no new key on the strict review schema.
- The 8 GiB host: the WIP caps stay. Only one agent deploy runs at a time, and the rest queue.
- A person's approval of a spec is still the only thing that authorises a merge or a deploy. Agents never approve specs.
- **Pilot first.** One real feature spec runs end to end before R-1 and R-2 are rewritten.

## Out of scope

- Multi-person review.
- Changing how prototypes render.
- A continuously maintained description of the system's current state, filed as W-63.

## Open questions

- Which feature to use as the pilot spec.
- Whether a version of poteto-mode that runs unattended is worth building, or whether R-3 keeps reading the SKILL.md file.
