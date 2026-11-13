/**
 * @fileoverview The landing decision for `/` under the canvas shell (PC13): every row of the setting table, the
 * classic override, a missing bundle, and where the workspace comes from. Pure; no server.
 *
 * Port: N/A.
 */
import { describe, expect, it } from 'vitest';
import { cookieValue, decideLanding, shellActive, LAST_WORKSPACE_COOKIE } from '../src/web/shell-landing.js';

const workspaces = [
  { id: 'ws-a', caseName: 'alpha' },
  { id: 'ws-b', caseName: 'beta' },
];
const base = { canvasEnabled: true, shellEnabled: true, query: {}, bundlePresent: true, workspaces };

describe('decideLanding', () => {
  it('leaves the dashboard alone unless both settings are on, whatever the query or the cookie say', () => {
    for (const [canvasEnabled, shellEnabled] of [
      [false, false],
      [true, false],
      [false, true],
    ]) {
      for (const query of [{}, { view: 'classic' }, { view: 'classic', canvas: 'failed', reason: 'load' }]) {
        expect(decideLanding({ ...base, canvasEnabled, shellEnabled, query, cookieWorkspaceId: 'ws-b' })).toEqual({
          kind: 'classic',
          shell: false,
          notice: null,
        });
      }
    }
  });

  it('opens the canvas with both settings on', () => {
    expect(decideLanding(base)).toEqual({ kind: 'canvas', workspaceId: 'ws-a' });
  });

  it('honours view=classic before anything else, with a notice only for a failed canvas and only from the fixed list', () => {
    expect(decideLanding({ ...base, query: { view: 'classic' } })).toEqual({
      kind: 'classic',
      shell: true,
      notice: null,
    });
    for (const reason of ['missing', 'load', 'boot'])
      expect(decideLanding({ ...base, query: { view: 'classic', canvas: 'failed', reason } })).toMatchObject({
        kind: 'classic',
        notice: reason,
      });
    for (const reason of [undefined, '<script>', ['load'], 'LOAD'])
      expect(decideLanding({ ...base, query: { view: 'classic', canvas: 'failed', reason } })).toMatchObject({
        notice: 'boot',
      });
    expect(decideLanding({ ...base, query: { view: 'classic', reason: 'load' } })).toMatchObject({ notice: null });
    // Without view=classic the failure flags mean nothing: the canvas is tried.
    expect(decideLanding({ ...base, query: { canvas: 'failed', reason: 'load' } }).kind).toBe('canvas');
  });

  it('shows the classic view with the notice when a canvas file is missing', () => {
    expect(decideLanding({ ...base, bundlePresent: false })).toEqual({
      kind: 'classic',
      shell: true,
      notice: 'missing',
    });
  });

  it('prefers the remembered workspace, then the last used case, then the first workspace', () => {
    expect(decideLanding({ ...base, cookieWorkspaceId: 'ws-b', lastUsedCase: 'alpha' })).toEqual({
      kind: 'canvas',
      workspaceId: 'ws-b',
    });
    expect(decideLanding({ ...base, lastUsedCase: 'beta' })).toEqual({ kind: 'canvas', workspaceId: 'ws-b' });
    expect(decideLanding({ ...base, lastUsedCase: 'gone' })).toEqual({ kind: 'canvas', workspaceId: 'ws-a' });
  });

  it("ignores a cookie that is malformed or names a workspace outside the caller's list", () => {
    for (const cookieWorkspaceId of ['ws-other', '../etc', 'a b', '', 'x'.repeat(129)])
      expect(decideLanding({ ...base, cookieWorkspaceId, lastUsedCase: 'beta' })).toEqual({
        kind: 'canvas',
        workspaceId: 'ws-b',
      });
  });

  it('is the first-run page when the person has no workspace', () => {
    expect(decideLanding({ ...base, workspaces: [], cookieWorkspaceId: 'ws-a', lastUsedCase: 'alpha' })).toEqual({
      kind: 'first-run',
    });
  });
});

describe('shellActive', () => {
  it('needs an explicit true for both keys', () => {
    expect(shellActive({ canvasEnabled: true, canvasShellEnabled: true })).toBe(true);
    for (const s of [
      {},
      { canvasEnabled: true },
      { canvasShellEnabled: true },
      { canvasEnabled: 'true', canvasShellEnabled: 1 },
    ])
      expect(shellActive(s)).toBe(false);
  });
});

describe('cookieValue', () => {
  it('reads one cookie and survives a header that does not decode', () => {
    expect(cookieValue(`a=1; ${LAST_WORKSPACE_COOKIE}=ws-b; codeman_session=secret`, LAST_WORKSPACE_COOKIE)).toBe(
      'ws-b'
    );
    expect(cookieValue('a=1', LAST_WORKSPACE_COOKIE)).toBeUndefined();
    expect(cookieValue(undefined, LAST_WORKSPACE_COOKIE)).toBeUndefined();
    expect(cookieValue(`${LAST_WORKSPACE_COOKIE}=%E0%A4%A`, LAST_WORKSPACE_COOKIE)).toBeUndefined();
  });
});
