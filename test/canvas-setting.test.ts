/**
 * @fileoverview The synced `canvasEnabled` and `canvasShellEnabled` settings have real switches
 * in App Settings: the strict settings schema admits them, the form reads each as ON unless the
 * stored value is an explicit false (`canvasSettingOn`, an absent key included) and saves the
 * checkbox by id (never a carried-over value), and the rows read in Chinese (zh-CN). The route
 * gate is pinned in the canvas route and store tests.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const SETTINGS_UI = readFileSync(resolve(PUBLIC, 'settings-ui.js'), 'utf8');
const ID = 'appSettingsCanvas';

type Api = { configure(o: Record<string, string>): void; start(): void };

function rowStrings(doc: Document): { label: string; description: string } {
  const row = doc.getElementById(ID)!.closest('.set-row')!;
  return {
    label: row.querySelector('.set-row-label')!.firstChild!.textContent!.trim(),
    description: row.querySelector('.set-row-desc')!.textContent!.trim(),
  };
}

const source = new JSDOM(INDEX);
const english = rowStrings(source.window.document);
const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.start();
api.configure({ language: 'zh-CN' });
const chinese = rowStrings(dom.window.document);

type SettingsApp = {
  cases: { name: string }[];
  casePickerActions(): { id: string }[];
  _buildMobileOverviewCanvasRows(): HTMLElement[];
  canvasSettingOn(key: string, settings?: Record<string, unknown> | null): boolean;
  loadAppSettingsFromStorage(): Record<string, unknown>;
  loadAppSettingsFromServer(server: Promise<Record<string, unknown>>): Promise<Record<string, unknown>>;
};

/** The settings module and the two that draw canvas entries, in a vm, with `stored` as this device's saved settings. */
function loadSettingsUi(stored: Record<string, unknown> | null): SettingsApp {
  const storage = new Map<string, string>();
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    document: source.window.document,
    console,
  });
  for (const file of ['settings-ui.js', 'session-ui.js', 'mobile-overview.js'])
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  const app = Object.create(CodemanApp.prototype) as SettingsApp & Record<string, unknown>;
  app.getSettingsStorageKey = () => 'settings';
  app.getDefaultSettings = () => ({});
  app._settingsReadOnly = () => true;
  app._applyOwnSettings = () => {};
  if (stored) storage.set('settings', JSON.stringify(stored));
  return app;
}

const KEYS = ['canvasEnabled', 'canvasShellEnabled'] as const;

describe('canvasSettingOn', () => {
  it.each(KEYS)('reads %s as on when the key is absent or true, and off only for an explicit false', (key) => {
    const app = loadSettingsUi(null);
    expect(app.canvasSettingOn(key, {})).toBe(true);
    expect(app.canvasSettingOn(key, { [key]: true })).toBe(true);
    expect(app.canvasSettingOn(key, { [key]: false })).toBe(false);
    // Each key is read alone: the other one being off changes nothing here.
    expect(app.canvasSettingOn(key, { [KEYS.find((k) => k !== key)!]: false })).toBe(true);
  });

  it.each(KEYS)("reads %s from this device's stored settings when none are passed", (key) => {
    expect(loadSettingsUi(null).canvasSettingOn(key)).toBe(true);
    expect(loadSettingsUi({ terminalFontSize: 14 }).canvasSettingOn(key)).toBe(true);
    expect(loadSettingsUi({ [key]: false }).canvasSettingOn(key)).toBe(false);
  });

  it.each(KEYS)('lets a server that has no %s win over a value this device stored earlier', async (key) => {
    const stale = loadSettingsUi({ [key]: false, terminalFontSize: 14 });
    const merged = await stale.loadAppSettingsFromServer(Promise.resolve({ autoNameSessions: true }));
    expect(key in merged).toBe(false);
    expect(merged.terminalFontSize).toBe(14);
    expect(stale.canvasSettingOn(key)).toBe(true);

    const off = loadSettingsUi({ [key]: true });
    await off.loadAppSettingsFromServer(Promise.resolve({ [key]: false }));
    expect(off.canvasSettingOn(key)).toBe(false);
  });

  it('draws the case picker entry and the phone canvas rows unless Canvas is stored as off', () => {
    for (const [stored, shown] of [
      [null, true],
      [{ canvasEnabled: true }, true],
      [{ canvasShellEnabled: false }, true],
      [{ canvasEnabled: false }, false],
    ] as const) {
      const app = loadSettingsUi(stored);
      app.cases = [{ name: 'alpha' }];
      const label = JSON.stringify(stored);
      expect(
        app.casePickerActions().some((a) => a.id === 'canvas'),
        label
      ).toBe(shown);
      expect(
        app._buildMobileOverviewCanvasRows().map((row) => row.dataset.moCase),
        label
      ).toEqual(shown ? ['alpha'] : []);
    }
  });

  it('is the only place the browser compares either key', () => {
    for (const file of ['settings-ui.js', 'session-ui.js', 'mobile-overview.js', 'app.js']) {
      const text = readFileSync(resolve(PUBLIC, file), 'utf8');
      expect(text.match(/canvas(Shell)?Enabled\s*[!=]==?/g) ?? [], file).toEqual([]);
    }
  });
});

afterAll(() => {
  source.window.close();
  dom.window.close();
});

describe('canvasEnabled', () => {
  it('is a boolean the strict settings schema accepts, and nothing else', () => {
    expect(SettingsUpdateSchema.safeParse({ canvasEnabled: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ canvasEnabled: false }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ canvasEnabled: 'yes' }).success).toBe(false);
  });

  it('has one checkbox in App Settings, off in the markup, loaded through canvasSettingOn and saved by id', () => {
    expect(INDEX.split(`id="${ID}"`)).toHaveLength(2);
    const box = source.window.document.getElementById(ID)!;
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.hasAttribute('checked')).toBe(false);
    expect(SETTINGS_UI).toContain(
      `document.getElementById('${ID}').checked = this.canvasSettingOn('canvasEnabled', settings);`
    );
    expect(SETTINGS_UI).toContain(`canvasEnabled: document.getElementById('${ID}').checked,`);
    expect(SETTINGS_UI).not.toContain('_prev.canvasEnabled');
  });

  it('is a synced setting, never a per-device display key', () => {
    const displayKeys = SETTINGS_UI.slice(SETTINGS_UI.indexOf('displayKeys = new Set(['));
    expect(displayKeys.slice(0, displayKeys.indexOf('])'))).not.toContain('canvasEnabled');
    const group = source.window.document.getElementById(ID)!.closest('.set-group')!;
    expect(group.querySelector('.set-group-head h4')!.textContent).toBe('Cross-session features');
    expect(group.querySelector('.set-group-head .set-scope')!.textContent).toBe('synced');
  });

  it('translates the label and the description', () => {
    expect(english.label).toBe('Canvas');
    expect(english.description).toMatch(/^Gives every case an infinite canvas/);
    expect(chinese.label).toBe('画布');
    expect(chinese.description).not.toBe(english.description);
    expect(chinese.description.match(/[A-Za-z]+/g) ?? []).toEqual([]);
  });
});

describe('canvasShellEnabled (PC13)', () => {
  const SHELL = 'appSettingsCanvasShell';
  const row = source.window.document.getElementById(SHELL)!.closest('.set-row')!;

  it('is a boolean the strict settings schema accepts, independent of the canvas switch', () => {
    expect(SettingsUpdateSchema.safeParse({ canvasShellEnabled: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ canvasShellEnabled: false, canvasEnabled: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ canvasShellEnabled: 'on' }).success).toBe(false);
  });

  it('has one checkbox beside the Canvas row, off in the markup, loaded through canvasSettingOn', () => {
    expect(INDEX.split(`id="${SHELL}"`)).toHaveLength(2);
    const box = source.window.document.getElementById(SHELL)!;
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.hasAttribute('checked')).toBe(false);
    expect(row.previousElementSibling!.id).toBe('appSettingsCanvasItem');
    expect(SETTINGS_UI).toContain(
      `document.getElementById('${SHELL}').checked = this.canvasSettingOn('canvasShellEnabled', settings);`
    );
    expect(SETTINGS_UI).toContain(`canvasShellEnabled: document.getElementById('${SHELL}').checked,`);
  });

  it('says what it does, where the classic dashboard stays, and that it needs the canvas', () => {
    const text = row.querySelector('.set-row-desc')!.textContent!;
    expect(row.querySelector('.set-row-label')!.firstChild!.textContent!.trim()).toBe('Open on the canvas');
    expect(text).toMatch(/the page Codeman opens on/);
    expect(text).toMatch(/classic dashboard stays at its own address, \/classic/);
    const needs = source.window.document.getElementById('appSettingsCanvasShellNeeds')!;
    expect(needs.hasAttribute('hidden')).toBe(true);
    expect(needs.textContent).toMatch(/^Needs Canvas turned on/);
    expect(SETTINGS_UI).toContain('needs.hidden = canvas.checked;');
  });

  it('is synced, never a per-device display key', () => {
    const displayKeys = SETTINGS_UI.slice(SETTINGS_UI.indexOf('displayKeys = new Set(['));
    expect(displayKeys.slice(0, displayKeys.indexOf('])'))).not.toContain('canvasShellEnabled');
    expect(row.closest('.set-group')!.querySelector('.set-group-head .set-scope')!.textContent).toBe('synced');
  });

  it('is sent to the server only by a save that changes it', () => {
    // A page left open across a rollback talks to a server whose strict schema does not know the key.
    // Compared with what this device resolved before, so a save with the box still ticked over an absent key
    // sends nothing, and unticking it sends an explicit false.
    expect(SETTINGS_UI).toContain('canvasShellEnabled: _cse,');
    expect(SETTINGS_UI).toContain(
      "const _shellFlip = _cse !== this.canvasSettingOn('canvasShellEnabled', _prev) ? { canvasShellEnabled: _cse } : {};"
    );
    expect(SETTINGS_UI).toMatch(/\.\.\.serverSettings,\n\s+\.\.\.\(_chipFlip[^\n]+\n\s+\.\.\.shellFlip,/);
    expect(SETTINGS_UI).toContain('await _putSettings(_shellFlip);');
  });

  it('reads in Chinese', () => {
    const zh = dom.window.document.getElementById(SHELL)!.closest('.set-row')!;
    expect(zh.querySelector('.set-row-label')!.firstChild!.textContent!.trim()).toBe('在画布上打开');
    expect(zh.querySelector('.set-row-desc')!.textContent).not.toBe(row.querySelector('.set-row-desc')!.textContent);
  });
});
