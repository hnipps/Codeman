/**
 * The bounds on an agent starting canvas work (owner instruction of 2026-11-13): the depth rule, the agents' share of a
 * canvas's places, who a record says started it, and that a record carrying that mark still reads under the previous
 * release. The routes are covered in canvas-conversations and canvas-task-routes.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentStartedAncestor,
  agentStartRefusal,
  MAX_AGENT_CONVERSATIONS,
  MAX_AGENT_TASKS,
  MAX_LINEAGE_HOPS,
  startedBy,
} from '../src/canvas/agent-start.js';
import { ConversationsFileSchema } from '../src/canvas/conversation-schema.js';
import { MAX_ACTIVE_TASKS, taskPart } from '../src/canvas/tasks.js';

describe('the depth rule', () => {
  const chain = (links: Record<string, string>) => (id: string) => links[id];
  it('finds agent-started work at the caller or anywhere up its spawn chain', () => {
    const started = new Set(['task-session']);
    expect(agentStartedAncestor('task-session', chain({}), started)).toBe('task-session');
    expect(agentStartedAncestor('w2', chain({ w2: 'w1', w1: 'task-session' }), started)).toBe('task-session');
    expect(agentStartedAncestor('person-tab', chain({ 'person-tab': 'other' }), started)).toBeUndefined();
  });
  it('ends on a cycle and at the hop bound', () => {
    expect(agentStartedAncestor('a', chain({ a: 'b', b: 'a' }), new Set(['z']))).toBeUndefined();
    const links: Record<string, string> = {};
    for (let i = 0; i < MAX_LINEAGE_HOPS + 5; i++) links[`s${i}`] = `s${i + 1}`;
    expect(agentStartedAncestor('s0', chain(links), new Set([`s${MAX_LINEAGE_HOPS}`]))).toBe(`s${MAX_LINEAGE_HOPS}`);
    expect(agentStartedAncestor('s0', chain(links), new Set([`s${MAX_LINEAGE_HOPS + 1}`]))).toBeUndefined();
  });
});

describe('the caps', () => {
  it('refuses nested work first, then past the agents share, and leaves the person places', () => {
    expect(agentStartRefusal({ kind: 'task', inLineage: 'x', agentLive: 0 })).toBe('NESTED_AGENT');
    expect(agentStartRefusal({ kind: 'task', inLineage: undefined, agentLive: MAX_AGENT_TASKS - 1 })).toBeUndefined();
    expect(agentStartRefusal({ kind: 'task', inLineage: undefined, agentLive: MAX_AGENT_TASKS })).toBe('AGENT_TASKS');
    expect(agentStartRefusal({ kind: 'conversation', inLineage: undefined, agentLive: MAX_AGENT_CONVERSATIONS })).toBe(
      'AGENT_CONVERSATIONS'
    );
    expect(MAX_AGENT_TASKS).toBeLessThan(MAX_ACTIVE_TASKS);
  });
});

describe('who started a record', () => {
  it('reads an agent mark and treats anything else as a person', () => {
    expect(startedBy({ startedBy: { kind: 'agent', sessionId: 's1' } })).toEqual({ kind: 'agent', sessionId: 's1' });
    for (const junk of [undefined, null, 'agent', { kind: 'human', userId: 'a' }, { kind: 'agent', sessionId: '' }])
      expect(startedBy({ startedBy: junk })).toBeUndefined();
  });
  it('a record an agent started parses under the previous release and comes back with its mark', () => {
    // The previous release's conversation schema: passthrough, with no startedBy key.
    const Previous = z
      .object({
        version: z.literal(1),
        conversations: z.array(
          z
            .object({
              id: z.uuid(),
              sessionId: z.string(),
              cliId: z.string(),
              task: z.unknown().optional(),
              createdAt: z.number(),
              createdBy: z.string(),
              messages: z.array(z.object({}).passthrough()),
            })
            .passthrough()
        ),
      })
      .passthrough();
    const record = {
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: 'session-2',
      cliId: 'claude',
      requestId: '11111111-1111-4111-8111-111111111111',
      createdAt: 10,
      createdBy: '@single',
      startedBy: { kind: 'agent', sessionId: 'agent-1' },
      task: {
        name: 'Fix it',
        requestId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        isolation: { kind: 'worktree', name: 'task-ab12cd34', branch: 'worktree-task-ab12cd34' },
      },
      messages: [],
    };
    const previous = Previous.parse({ version: 1, conversations: [record] });
    const back = ConversationsFileSchema.parse(JSON.parse(JSON.stringify(previous)));
    expect(startedBy(back.conversations[0])).toEqual({ kind: 'agent', sessionId: 'agent-1' });
    expect(taskPart(back.conversations[0])?.name).toBe('Fix it');
  });
});
