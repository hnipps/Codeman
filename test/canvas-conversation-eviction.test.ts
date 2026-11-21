/** Which canvas records hold a place under the cap, and the order a full canvas evicts the rest in. */
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  conversationActive,
  evictionOrder,
  type ActivityEvidence,
} from '../src/canvas/conversation-eviction.js';

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const ago = (minutes: number) => NOW - minutes * MIN;
const live = (quietMinutes: number, extra: Partial<NonNullable<ActivityEvidence['session']>> = {}) => ({
  exited: false,
  working: false,
  lastActivityAt: ago(quietMinutes),
  ...extra,
});
const record = (session: ActivityEvidence['session'], createdMinutesAgo = 300): ActivityEvidence => ({
  createdAt: ago(createdMinutesAgo),
  messages: [],
  ...(session ? { session } : {}),
});

describe('conversationActive', () => {
  it('uses a one hour window', () => {
    expect(ACTIVE_WINDOW_MS).toBe(60 * MIN);
  });
  it.each([
    ['working now, quiet for a day', record(live(24 * 60, { working: true })), true],
    ['idle 59 minutes', record(live(59)), true],
    ['idle 61 minutes', record(live(61)), false],
    // A question or approval paints the pane; the agent then waits on the person.
    ['waiting on a person for 30 minutes', record(live(30)), true],
    ['waiting on a person for 2 hours', record(live(120)), false],
    ['a prompt submitted 10 minutes ago into a quiet pane', record(live(300, { lastSubmitAt: ago(10) })), true],
    ['agent exited 5 minutes ago', record(live(5, { exited: true })), false],
    ['agent exited while working', record(live(1, { exited: true, working: true })), false],
    ['session gone', record(undefined, 1), false],
  ])('%s', (_label, evidence, active) => {
    expect(conversationActive(evidence, NOW)).toBe(active);
  });
  it('counts a message the canvas sent as activity, so a request still being delivered keeps its place', () => {
    const queued: ActivityEvidence = {
      createdAt: ago(300),
      messages: [{ sentAt: ago(2), deliveredAt: null }],
      session: live(300),
    };
    expect(conversationActive(queued, NOW)).toBe(true);
  });
  it('falls back to the creation time when the session reports no activity', () => {
    expect(conversationActive(record({ exited: false, working: false }, 20), NOW)).toBe(true);
    expect(conversationActive(record({ exited: false, working: false }, 90), NOW)).toBe(false);
  });
});

describe('background tasks, by the state the task list shows', () => {
  // A task's state is derived from the same evidence; what decides its place is the session and its activity.
  it.each([
    ['running: the turn is working', live(200, { working: true }), true],
    ['waiting: an approval asked 20 minutes ago', live(20), true],
    ['waiting: an approval nobody answered for 3 hours', live(180), false],
    ['completed 10 minutes ago, session still open', live(10), true],
    ['completed 2 hours ago, session still open', live(120), false],
    ['cancelled, session discarded', undefined, false],
    ['failed: the agent exited', live(3, { exited: true }), false],
  ])('%s', (_label, session, active) => {
    expect(conversationActive(record(session), NOW)).toBe(active);
  });
});

describe('evictionOrder', () => {
  it('lists the inactive records only, oldest activity first, creation breaking a tie', () => {
    const rows = [
      { id: 'active', evidence: record(live(5)) },
      { id: 'quiet-2h', evidence: record(live(120)) },
      { id: 'gone-new', evidence: record(undefined, 70) },
      { id: 'gone-old', evidence: record(undefined, 400) },
      { id: 'tie-later', evidence: { createdAt: ago(500), messages: [], session: live(200) } },
      { id: 'tie-earlier', evidence: { createdAt: ago(600), messages: [], session: live(200) } },
    ];
    expect(evictionOrder(rows, NOW).map((r) => r.id)).toEqual([
      'gone-old',
      'tie-earlier',
      'tie-later',
      'quiet-2h',
      'gone-new',
    ]);
  });
});
