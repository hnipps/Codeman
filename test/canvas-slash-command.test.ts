import { describe, expect, it } from 'vitest';
import { slashCommand } from '../src/canvas/conversation-schema.js';
import { buildThread } from '../packages/canvas/src/conversation.js';
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
  it('drops a delivered command from the thread, which never gets a transcript row, but shows one still travelling', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const record = (extra: object) =>
      ({
        messageId: id,
        deliveredAt: 1,
        author: { kind: 'human', userId: 'u' },
        refs: [],
        command: true,
        ...extra,
      }) as never;
    const sent = [{ messageId: id, text: '/help', refIds: [] }];
    expect(buildThread([], [record({ state: 'delivered' })], sent)).toEqual([]);
    const failed = buildThread([], [record({ state: 'failed', deliveredAt: null })], sent);
    expect(failed.map((t) => [t.label, t.text])).toEqual([['You · Not delivered', '/help']]);
  });
});
