/**
 * @fileoverview Ambient capture, ticket 7: the per-device `captureTabMode` setting is wired so it
 * loads and saves by id and never reaches the strict server schema. The tab path itself is
 * covered by test/capture-tab-mode.browser.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');
const html = read('src/web/public/index.html');
const settingsUi = read('src/web/public/settings-ui.js');
const schemas = read('src/web/schemas.ts');
const capture = read('src/web/public/capture.js');

describe('captureTabMode setting', () => {
  // Invariant T1: TabModeIsOptIn
  it('is a per-device key that stays out of the settings PUT', () => {
    const displayKeys = settingsUi.slice(settingsUi.indexOf('_displaySettingKeySet() {'));
    expect(displayKeys.slice(0, displayKeys.indexOf('return displayKeys;'))).toContain("'captureTabMode'");
    expect(settingsUi).toMatch(/captureTabMode: _\w+,/);
    expect(schemas).not.toContain('captureTabMode');
  });

  // Invariant T1: TabModeIsOptIn
  it('loads and saves by id, off unless exactly true', () => {
    expect(html).toContain('id="appSettingsCaptureTabMode"');
    expect(settingsUi).toMatch(
      /const (\w+) = document\.getElementById\('appSettingsCaptureTabMode'\);\s*\1\.checked = settings\.captureTabMode === true;/
    );
    expect(settingsUi).toContain("captureTabMode: document.getElementById('appSettingsCaptureTabMode').checked,");
    expect(capture).toMatch(/captureTabMode === true/);
  });
});
