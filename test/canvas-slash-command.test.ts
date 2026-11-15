import { describe, expect, it } from 'vitest';
import { slashCommand } from '../src/canvas/conversation-schema.js';
import { buildThread } from '../packages/canvas/src/conversation.js';
import { weave } from '../packages/canvas/src/activity.js';
import { getCli } from '../src/config/cli-registry/registry.js';

const person = { author: { kind: 'human' as const }, slashCommands: true };

describe('slash commands from the canvas chat box', () => {
  it('forwards only a command word a person typed, trimmed', () => {
    expect(slashCommand('/compact', person)).toBe('/compact');
    expect(slashCommand('  /pstack:poteto-mode work on W-44 \n', person)).toBe('/pstack:poteto-mode work on W-44');
    expect(slashCommand('/help\nmore', person)).toBe('/help\nmore');
    for (const text of ['/home/x/y.ts broken', '/ space', '//x', 'see /help', '/1abc', '/'])
      expect(slashCommand(text, person)).toBeUndefined();
  });
  it('keeps an agent, a thread request and a CLI without commands wrapped (the injection boundary)', () => {
    expect(slashCommand('/clear', { ...person, author: { kind: 'agent' } })).toBeUndefined();
    expect(slashCommand('/clear', { ...person, origin: { kind: 'thread' } })).toBeUndefined();
    expect(slashCommand('/clear', { ...person, slashCommands: false })).toBeUndefined();
  });
  it('is declared by claude through the registry and by nothing unmeasured', () => {
    expect(getCli('claude')?.capabilities.slashCommands).toBe(true);
    expect(getCli('shell')?.capabilities.slashCommands).toBeUndefined();
  });
  it('keeps a delivered command in the thread, placed by when it was written among the transcript rows', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const record = (extra: object) =>
      ({
        messageId: id,
        sentAt: 150,
        submittedAt: 160,
        deliveredAt: 170,
        author: { kind: 'human', userId: 'u' },
        refs: [],
        command: true,
        ...extra,
      }) as never;
    const sent = [{ messageId: id, text: '/help', refIds: [] }];
    const rows = [
      { role: 'user' as const, text: 'first', at: 100 },
      { role: 'assistant' as const, text: 'one', at: 120 },
      { role: 'user' as const, text: 'second', at: 200 },
      { role: 'assistant' as const, text: 'two', at: 220 },
    ];
    const turns = buildThread(rows, [record({ state: 'delivered' })], sent);
    const command = turns.at(-1)!;
    expect(command).toMatchObject({ label: 'You · Command', text: '/help', command: true, at: 160 });
    expect(command.pending).toBeUndefined();
    const order = weave(turns, rows.length, { tools: [], releases: [], dropped: 0 } as never).flatMap((item) =>
      item.kind === 'turn' ? [item.turn.text] : []
    );
    expect(order).toEqual(['first', 'one', '/help', 'second', 'two']);
    // Rows with no time (an older server) leave it at the end, as before.
    const untimed = rows.map(({ role, text }) => ({ role, text }));
    const tail = weave(buildThread(untimed, [record({ state: 'delivered' })], sent), 4, {
      tools: [],
      releases: [],
      dropped: 0,
    } as never).flatMap((item) => (item.kind === 'turn' ? [item.turn.text] : []));
    expect(tail).toEqual(['first', 'one', 'second', 'two', '/help']);
    // One still travelling or not delivered says so, with no command label.
    const failed = buildThread([], [record({ state: 'failed', deliveredAt: null })], sent);
    expect(failed.map((t) => [t.label, t.text])).toEqual([['You · Not delivered', '/help']]);
  });
});
