/**
 * @fileoverview The bounds on an agent starting canvas work (owner instruction of 2026-11-13). A person's click and an
 * agent's tool call reach the same create functions; this module holds the extra rules an agent caller is held to,
 * pure so the tests exercise them directly: who started a record, whether a caller sits below agent-started work, and
 * the agents' share of a canvas's places. Shared by the server and the browser; nothing here touches disk or a session.
 */
import { z } from 'zod';

/** Live conversations an agent started that one canvas holds at once; the rest of the fifty places stay the person's. */
export const MAX_AGENT_CONVERSATIONS = 2;
/** Active background tasks agents started on one canvas; the person always keeps the other places of the four. */
export const MAX_AGENT_TASKS = 2;
/** How far up a spawn chain the depth rule looks before it stops. */
export const MAX_LINEAGE_HOPS = 32;

/**
 * Who started a record. A routine run is an agent for every rule: the shared AGENT_CAP, depth one below it, NOT_YOURS.
 */
export type StartedBy = { kind: 'agent'; sessionId: string } | { kind: 'routine'; routineId: string; runId: string };
const StoredStartedBy = z
  .object({
    kind: z.literal('agent'),
    sessionId: z.string().min(1).max(128),
    routineId: z.string().min(1).max(128).optional(),
    runId: z.string().min(1).max(128).optional(),
  })
  .passthrough();
/**
 * The stored form of `startedBy`. A routine run is stored as `{ kind: 'agent', sessionId: <the run's own session>,
 * routineId, runId }`, so the previous release (which reads `kind: 'agent'` with passthrough) still counts it toward
 * AGENT_CAP and still keeps the run's session below agent-started work after a rollback. A `kind: 'routine'` on disk
 * would read there as a person's task and lift both bounds. This encoder and `startedBy()` are the only two places
 * that know the stored shape.
 */
export function storedStartedBy(starter: StartedBy, runSessionId: string): Record<string, string> {
  return starter.kind === 'agent'
    ? { kind: 'agent', sessionId: starter.sessionId }
    : { kind: 'agent', sessionId: runSessionId, routineId: starter.routineId, runId: starter.runId };
}
/** Who started a record: an agent session, a routine, or undefined for a person (and every earlier release's record). */
export function startedBy(source: { startedBy?: unknown }): StartedBy | undefined {
  const parsed = StoredStartedBy.safeParse(source.startedBy);
  if (!parsed.success) return undefined;
  const { sessionId, routineId, runId } = parsed.data;
  return routineId && runId ? { kind: 'routine', routineId, runId } : { kind: 'agent', sessionId };
}

/**
 * The agent-started session at or above `caller`, following each session's recorded spawn parent, or undefined when
 * the chain reaches none. The chain stops at a session that is gone, a cycle, or `MAX_LINEAGE_HOPS`. A parent link can
 * only take a start away here, never grant one, which is why a caller-chosen value is acceptable as its source.
 */
export function agentStartedAncestor(
  caller: string,
  parentOf: (sessionId: string) => string | undefined,
  agentStarted: ReadonlySet<string>
): string | undefined {
  const seen = new Set<string>();
  let current: string | undefined = caller;
  for (let hop = 0; current && hop <= MAX_LINEAGE_HOPS && !seen.has(current); hop++) {
    if (agentStarted.has(current)) return current;
    seen.add(current);
    current = parentOf(current);
  }
  return undefined;
}

export const AGENT_START_REFUSALS = {
  NESTED_AGENT:
    'NESTED_AGENT: this session was started by an agent, or by a session an agent started, so it cannot start more agent work. Ask the person to start it from the canvas.',
  AGENT_CONVERSATIONS: `AGENT_CAP: agents keep at most ${MAX_AGENT_CONVERSATIONS} live conversations on a canvas; ask the person to end one or start this one themselves`,
  AGENT_TASKS: `AGENT_CAP: agents run at most ${MAX_AGENT_TASKS} background tasks at once on a canvas; wait for one to finish or ask the person`,
  NOT_YOURS: 'NOT_YOURS: an agent can cancel or remove only a task it started itself; ask the person to do it',
} as const;
export type AgentStartRefusal = keyof typeof AGENT_START_REFUSALS;

/**
 * Whether an agent may start one more conversation or task here. `inLineage` is the result of `agentStartedAncestor`
 * for the caller; `agentLive` counts the live conversations or active tasks agents started on this canvas.
 */
export function agentStartRefusal(input: {
  kind: 'conversation' | 'task';
  inLineage: string | undefined;
  agentLive: number;
}): AgentStartRefusal | undefined {
  if (input.inLineage) return 'NESTED_AGENT';
  if (input.kind === 'conversation' && input.agentLive >= MAX_AGENT_CONVERSATIONS) return 'AGENT_CONVERSATIONS';
  if (input.kind === 'task' && input.agentLive >= MAX_AGENT_TASKS) return 'AGENT_TASKS';
  return undefined;
}
