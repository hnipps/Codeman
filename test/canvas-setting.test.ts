/**
 * @fileoverview The synced `canvasEnabled` setting (default OFF) has a real switch in App
 * Settings: the strict settings schema admits it, the form loads it only from an explicit
 * true and saves the checkbox by id (never a carried-over value), and its row reads in
 * Chinese (zh-CN). The route gate is pinned in the canvas route and store tests.
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

  it('has one checkbox in App Settings, off in the markup, loaded only from an explicit true and saved by id', () => {
    expect(INDEX.split(`id="${ID}"`)).toHaveLength(2);
    const box = source.window.document.getElementById(ID)!;
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.hasAttribute('checked')).toBe(false);
    expect(SETTINGS_UI).toContain(`document.getElementById('${ID}').checked = settings.canvasEnabled === true;`);
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

  it('has one checkbox beside the Canvas row, off in the markup, loaded only from an explicit true', () => {
    expect(INDEX.split(`id="${SHELL}"`)).toHaveLength(2);
    const box = source.window.document.getElementById(SHELL)!;
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.hasAttribute('checked')).toBe(false);
    expect(row.previousElementSibling!.id).toBe('appSettingsCanvasItem');
    expect(SETTINGS_UI).toContain(
      `document.getElementById('${SHELL}').checked = settings.canvasShellEnabled === true;`
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
    expect(SETTINGS_UI).toContain('canvasShellEnabled: _cse,');
    expect(SETTINGS_UI).toContain(
      'const _shellFlip = _cse !== (_prev.canvasShellEnabled === true) ? { canvasShellEnabled: _cse } : {};'
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
