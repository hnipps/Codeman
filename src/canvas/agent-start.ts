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

export type StartedBy = { kind: 'agent'; sessionId: string };
const StoredStartedBy = z.object({ kind: z.literal('agent'), sessionId: z.string().min(1).max(128) }).passthrough();
/** Who started a record: an agent session, or undefined for a person (and for every record of an earlier release). */
export function startedBy(source: { startedBy?: unknown }): StartedBy | undefined {
  const parsed = StoredStartedBy.safeParse(source.startedBy);
  return parsed.success ? { kind: 'agent', sessionId: parsed.data.sessionId } : undefined;
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
