/**
 * @fileoverview Rollback safety of the shell switch (PC13). `settings.json` rolls forward: once written,
 * `canvasShellEnabled` stays in the file when an older release runs. The previous release's `PUT /api/settings`
 * schema is strict and does not know the key, so three things must hold: the previous release's page never sends
 * it (its save body is a fixed list built from its own form), the server merges a save into the file instead of
 * replacing it, and this release's page, left open across a rollback, sends the key only in a save that changes
 * it. What happens in that last case is pinned here too: the whole PUT is refused (400), so the page saves the
 * rest without the key, puts the box back and says the switch was not saved.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SettingsUpdateSchema } from '../src/web/schemas.js';
import { shellActive } from '../src/web/shell-landing.js';

const SETTINGS_UI = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
const SYSTEM_ROUTES = readFileSync(resolve(import.meta.dirname, '../src/web/routes/system-routes.ts'), 'utf8');

// The previous release's schema, as far as this key goes: the same strict object without it.
const { canvasShellEnabled: _added, ...previousShape } = SettingsUpdateSchema.shape;
const PreviousSettingsUpdateSchema = z.object(previousShape).strict();

describe('the shell switch across a rollback', () => {
  it('is the only key this change adds to the strict settings schema', () => {
    expect(_added).toBeDefined();
    expect(Object.keys(SettingsUpdateSchema.shape).filter((k) => !(k in previousShape))).toEqual([
      'canvasShellEnabled',
    ]);
  });

  it('a save that does not change the switch parses in the previous release', () => {
    // What this release's page sends when the box was not touched: every synced key except the switch.
    const body = { canvasEnabled: true, approvalsInboxEnabled: false, autoNameSessions: false };
    expect(PreviousSettingsUpdateSchema.safeParse(body).success).toBe(true);
    expect(SETTINGS_UI).toContain(
      'const _shellFlip = _cse !== (_prev.canvasShellEnabled === true) ? { canvasShellEnabled: _cse } : {};'
    );
  });

  it('a save that changes the switch is refused whole by the previous release, and the page reports it', () => {
    const result = PreviousSettingsUpdateSchema.safeParse({ canvasEnabled: true, canvasShellEnabled: false });
    expect(result.success).toBe(false);
    // The page then saves the rest without the key, puts the box back and says so.
    expect(SETTINGS_UI).toContain("if (res && res.status === 400 && 'canvasShellEnabled' in _shellFlip) {");
    expect(SETTINGS_UI).toContain('const retry = await _putSettings({});');
    expect(SETTINGS_UI).toContain('settings.canvasShellEnabled = _prev.canvasShellEnabled === true;');
    expect(SETTINGS_UI).toContain('this server does not have it. Reload the page.');
  });

  it('the save body is built from the form, never from a spread of what the server sent', () => {
    const start = SETTINGS_UI.indexOf(
      '    const settings = {',
      SETTINGS_UI.indexOf('const _prev = this.loadAppSettingsFromStorage();')
    );
    const literal = SETTINGS_UI.slice(start, SETTINGS_UI.indexOf('\n    };', start));
    const spreads = [...literal.matchAll(/^\s*\.\.\.(.+)$/gm)].map((m) => m[1].trim());
    // One helper, which returns at most the two backup-retention keys. A previous release's page therefore
    // cannot echo a key it has no form control for.
    expect(spreads).toEqual(['this._configBackupRetentionPayload(_prev),']);
  });

  it('the server merges a save into the stored file, so a key the saving page does not know is kept', () => {
    expect(SYSTEM_ROUTES).toContain('mutateSettingsFile((current) => ({ ...current, ...settingsToStore }))');
  });

  it('the previous release ignores the stored key: it only ever reads the keys it knows', () => {
    // The previous release reads `canvasEnabled` alone, so with the key present `/` is the dashboard there.
    const stored = { canvasEnabled: true, canvasShellEnabled: true };
    expect(stored.canvasEnabled === true).toBe(true);
    expect(shellActive(stored)).toBe(true);
    expect(shellActive({ canvasEnabled: true })).toBe(false);
  });
});
