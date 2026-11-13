import { describe, expect, it } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
import {
  canSeeWaitingDialog,
  deliveryEvidence,
  launchFields,
  modelIdRefusal,
  providerRow,
  providerRows,
} from '../src/canvas/providers.js';
import {
  modelField,
  modelSuggestions,
  newConversationNotice,
  selection,
  agentLabel,
} from '../packages/canvas/src/providers.js';
import { buildThread, sendFailure } from '../packages/canvas/src/conversation.js';
import { parseChoice } from '../packages/canvas/src/assistant.js';
import { command, initialView } from '../packages/canvas/src/commands.js';
import { editShortcuts } from '../packages/canvas/src/shortcuts.js';

const stock = (id: string): CliEntry => STOCK_CLIS.find((e) => (e.id as string) === id)!;
const custom = (over: {
  id: string;
  model?: CliEntry['capabilities']['model'];
  hooks?: CliEntry['capabilities']['hooks'];
  field?: string;
}): CliEntry => {
  const base = stock('copilot');
  return {
    ...base,
    id: over.id as CliEntry['id'],
    label: over.id,
    stock: false,
    capabilities: {
      ...base.capabilities,
      model: over.model ?? base.capabilities.model,
      hooks: over.hooks ?? base.capabilities.hooks,
      workDetect: { ...base.capabilities.workDetect, blockedLine: 'Allow\\?' },
    },
    launch: { ...base.launch, legacyConfigField: over.field ?? base.launch.legacyConfigField },
  } as CliEntry;
};

describe('which CLIs a conversation can start on', () => {
  it('lists enabled, installed agent CLIs from the registry in registry order, never a shell', () => {
    const rows = providerRows(STOCK_CLIS, (e) => (e.id as string) !== 'codex');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('claude');
    expect(ids).not.toContain('shell');
    expect(ids).not.toContain('codex');
    expect(ids).toEqual([...ids].sort((a, b) => stock(a).order - stock(b).order));
    expect(providerRows([{ ...stock('claude'), enabled: false }], () => true)).toEqual([]);
  });

  it('a custom registry entry appears without any change here', () => {
    const entry = custom({ id: 'acme', model: { source: 'flag', param: 'model' }, field: 'copilotConfig' });
    const rows = providerRows([...STOCK_CLIS, entry], () => true);
    expect(rows.find((r) => r.id === 'acme')).toMatchObject({ label: 'acme', available: true });
  });

  it('is available only where a submit can be confirmed, and says why not otherwise', () => {
    expect(deliveryEvidence(stock('claude').capabilities)).toBe('hook');
    expect(deliveryEvidence(stock('copilot').capabilities)).toBe('composer');
    for (const id of ['codex', 'gemini', 'pi', 'deepseek']) {
      const row = providerRow(stock(id));
      expect(row.available, id).toBe(false);
      expect(row.reason, id).toMatch(/confirm a message was submitted/);
    }
    expect(providerRow(stock('claude'))).not.toHaveProperty('reason');
  });

  it('a composer-only CLI that cannot show Codeman its waiting dialog is unavailable, with its own reason', () => {
    expect(canSeeWaitingDialog(stock('claude').capabilities)).toBe(true);
    expect(canSeeWaitingDialog(stock('copilot').capabilities)).toBe(false);
    const row = providerRow(stock('copilot'));
    expect(row.available).toBe(false);
    expect(row.reason).toBe(
      'GitHub Copilot cannot tell Codeman when it is waiting for your answer, so a conversation cannot start on it yet.'
    );
    const base = stock('copilot');
    const withLine = {
      ...base,
      capabilities: { ...base.capabilities, workDetect: { ...base.capabilities.workDetect, blockedLine: 'Allow\\?' } },
    } as CliEntry;
    expect(providerRow(withLine)).toMatchObject({ available: true });
    const withHooks = { ...base, capabilities: { ...base.capabilities, hooks: 'supervised' } } as CliEntry;
    expect(providerRow(withHooks)).toMatchObject({ available: true });
  });

  it('a CLI with no model source disables the model with an inline reason', () => {
    const row = providerRow(custom({ id: 'fixed', model: { source: 'none' } }));
    expect(row.model).toMatchObject({ editable: false, source: 'none' });
    expect(row.model.reason).toMatch(/own configuration/);
    expect(modelField(row, 'x')).toMatchObject({ disabled: true });
    expect(modelField(row, 'x').reason).toMatch(/own configuration/);
  });
});

describe('how a chosen model reaches the launch', () => {
  it("claude's per-session `model` carries it, and modelOverride is never produced", () => {
    expect(launchFields(stock('claude'), 'opus[1m]')).toEqual({ ok: true, fields: { model: 'opus[1m]' } });
    for (const id of ['claude', 'copilot', 'codex', 'omp'])
      expect(JSON.stringify(launchFields(stock(id), 'm1'))).not.toContain('modelOverride');
  });

  it('a flag CLI writes the model into its own config object under its registry key', () => {
    expect(launchFields(stock('copilot'), 'gpt-5/mini')).toEqual({
      ok: true,
      fields: { copilotConfig: { model: 'gpt-5/mini' } },
    });
    expect(launchFields(stock('codex'), 'o4')).toEqual({ ok: true, fields: { codexConfig: { model: 'o4' } } });
    expect(launchFields(custom({ id: 'acme', field: 'ompConfig' }), 'x')).toEqual({
      ok: true,
      fields: { ompConfig: { model: 'x' } },
    });
  });

  it('no model is no field at all: the CLI keeps its own default', () => {
    expect(launchFields(stock('claude'), '')).toEqual({ ok: true, fields: {} });
    expect(launchFields(stock('copilot'), '')).toEqual({ ok: true, fields: {} });
  });

  it('refuses a model for a CLI that takes none, or that has no config object to put it in', () => {
    expect(launchFields(custom({ id: 'fixed', model: { source: 'none' } }), 'x').ok).toBe(false);
    const noField = custom({ id: 'bare', model: { source: 'flag', param: 'model' } });
    noField.launch = { ...noField.launch, legacyConfigField: undefined };
    expect(launchFields(noField, 'x')).toMatchObject({ ok: false });
  });

  it('holds a model id to the shape its launch accepts, since it reaches a command line', () => {
    for (const bad of ['--yolo', '-x', 'a b', 'a;b', '$(x)', 'a\nb', 'a'.repeat(101), '../x', "a'b"])
      expect(modelIdRefusal('claude-settings-file', bad), bad).toBeTruthy();
    for (const bad of ['--yolo', 'a b', 'a[1m]', '/abs', 'a;b']) expect(modelIdRefusal('flag', bad), bad).toBeTruthy();
    expect(modelIdRefusal('claude-settings-file', 'opus[1m]')).toBeUndefined();
    expect(modelIdRefusal('claude-settings-file', 'claude/opus')).toBeTruthy();
    expect(modelIdRefusal('flag', 'openai/gpt-5.1')).toBeUndefined();
    expect(modelIdRefusal('flag', '')).toBeUndefined();
    expect(modelIdRefusal('none', 'x')).toBeTruthy();
  });
});

describe('the selectors', () => {
  const rows = providerRows(STOCK_CLIS, (e) => ['claude', 'codex', 'copilot'].includes(e.id as string));
  it('shows the first provider that can start a conversation until the person chooses', () => {
    expect(selection(rows, null).row?.id).toBe('claude');
    expect(selection(rows, { cliId: 'copilot', model: '' }).row?.id).toBe('copilot');
    expect(selection(rows, { cliId: 'codex', model: '' }).row).toMatchObject({ id: 'codex', available: false });
  });
  it('reports a provider that has gone with an inline alternative, never silently', () => {
    const sel = selection(rows, { cliId: 'gemini', model: '' });
    expect(sel.stale).toBe(true);
    expect(sel.alternative?.id).toBe('claude');
  });
  it('words the new-conversation notice only when the choice differs from the bound conversation', () => {
    const bound = { cliId: 'claude', model: 'opus' };
    const same = { cliId: 'claude', model: 'opus' };
    expect(newConversationNotice(bound, same, selection(rows, same))).toBe('');
    expect(newConversationNotice(bound, null, selection(rows, null))).toBe('');
    expect(newConversationNotice(undefined, same, selection(rows, same))).toBe('');
    const other = { cliId: 'copilot', model: 'gpt-5' };
    expect(newConversationNotice(bound, other, selection(rows, other))).toBe(
      'Next message starts a new conversation on GitHub Copilot · gpt-5'
    );
    const model = { cliId: 'claude', model: 'sonnet' };
    expect(newConversationNotice(bound, model, selection(rows, model))).toMatch(
      /new conversation on Claude Code · sonnet/
    );
  });
  it('suggests models this canvas already used on that provider', () => {
    const list = [
      { cliId: 'claude', model: 'opus' },
      { cliId: 'claude', model: 'opus' },
      { cliId: 'copilot', model: 'gpt-5' },
      { cliId: 'claude' },
    ];
    expect(modelSuggestions(list, 'claude')).toEqual(['opus']);
  });
  it('keeps the choice in view state, and an agent set and a clear both go through the one reducer', () => {
    const set = command(initialView(), { kind: 'assistant-choice', choice: { cliId: 'copilot', model: 'm' } }, []);
    expect(set.choice).toEqual({ cliId: 'copilot', model: 'm' });
    expect(command(set, { kind: 'assistant-choice', choice: null }, []).choice).toBeNull();
    expect(initialView().choice).toBeNull();
  });
  it('reads a stored choice only if it is exactly a provider and a model', () => {
    expect(parseChoice(JSON.stringify({ cliId: 'claude', model: 'opus' }))).toEqual({ cliId: 'claude', model: 'opus' });
    expect(parseChoice(JSON.stringify({ cliId: null, model: '' }))).toEqual({ cliId: null, model: '' });
    for (const raw of [null, '', '{', '[]', JSON.stringify({ cliId: 3, model: '' }), JSON.stringify({ cliId: 'a' })])
      expect(parseChoice(raw)).toBeNull();
  });
  it('labels an agent row with its provider and model', () => {
    expect(agentLabel({ cliId: 'copilot', cliLabel: 'GitHub Copilot', model: 'gpt-5' })).toBe('GitHub Copilot · gpt-5');
    expect(agentLabel({ cliId: 'x' })).toBe('x');
    const turns = buildThread([{ role: 'assistant', text: 'hi' }], [], [], 'GitHub Copilot · gpt-5');
    expect(turns[0].label).toBe('GitHub Copilot · gpt-5');
  });
  it('words the provider refusals for the composer', () => {
    expect(sendFailure('CLI_UNAVAILABLE: Codex cannot.', 409).text).toMatch(/Codex cannot\. Pick another provider/);
    expect(sendFailure('UNKNOWN_CLI: x', 400).text).toMatch(/no longer available/);
    expect(sendFailure('INVALID_MODEL: A model id is bad.', 400).text).toMatch(
      /A model id is bad\. Your message is kept/
    );
  });
});

describe('Keys', () => {
  it('lists the new bindings, and marks the ones that arrive later as not bound', () => {
    const rows = new Map(editShortcuts.map(([title, chords, later]) => [title, { chords, later }]));
    expect(rows.get('Choose chat provider / model (focus the selector)')).toEqual({
      chords: [['P'], ['Shift', 'P']],
      later: undefined,
    });
    expect(rows.get('Send chat message / line break')?.later).toBeUndefined();
    const later = editShortcuts.filter((r) => r[2] === 'later').map((r) => r[1].map((c) => c.join('+')).join(','));
    // B and Shift+B are live since PC11.
    expect(later.sort()).toEqual(['G', 'Mod+Shift+Enter']);
  });
});
