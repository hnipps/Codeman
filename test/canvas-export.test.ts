import { describe, expect, it } from 'vitest';
import { exportChoice, exportFileName, exportRequest } from '../packages/canvas/src/export.js';
import type { ViewObject } from '../packages/canvas/src/model.js';

const object = (id: string, type: string, content: ViewObject['content']): ViewObject => ({
  id,
  type,
  parentId: null,
  order: 0,
  position: { x: 0, y: 0 },
  size: type === 'group' ? null : { width: 10, height: 10 },
  rotation: 0,
  content,
  author: { kind: 'human', userId: 'u' },
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});
const objects = [
  object('notes', 'section', { type: 'section', label: 'Release notes' }),
  object('inner', 'subcanvas', { type: 'subcanvas', workspaceId: 'w', label: 'Inner board' }),
  object('t', 'text', { type: 'text', text: 'hello' }),
];

describe('canvas export targets', () => {
  it('names the open canvas: the workspace at the top level, the sub-canvas when one is open', () => {
    expect(exportChoice('canvas', { root: null, selected: ['t'] }, objects, 'my-case')).toEqual({
      target: { id: null, name: 'my-case' },
    });
    expect(exportChoice('canvas', { root: 'inner', selected: [] }, objects, 'my-case')).toEqual({
      target: { id: 'inner', name: 'Inner board' },
    });
    expect(exportChoice('canvas', { root: 'removed', selected: [] }, objects, 'my-case')).toHaveProperty('reason');
  });

  it('exports exactly one selected object and says why it cannot otherwise', () => {
    expect(exportChoice('selection', { root: null, selected: ['notes'] }, objects, 'c')).toEqual({
      target: { id: 'notes', name: 'Release notes' },
    });
    expect(exportChoice('selection', { root: null, selected: [] }, objects, 'c')).toEqual({
      reason: 'Select one object first.',
    });
    expect(exportChoice('selection', { root: null, selected: ['notes', 't'] }, objects, 'c')).toEqual({
      reason: 'Select one object, or group the selection first.',
    });
  });

  it("asks for what an agent's canvas_screenshot and canvas_read ask for", () => {
    expect(exportRequest('ws', { id: 'notes', name: 'n' }, 'png', 'light')).toEqual({
      method: 'GET',
      path: '/api/canvas/ws/objects/notes/screenshot?theme=light',
    });
    expect(exportRequest('ws', { id: null, name: 'n' }, 'png', 'dark')).toEqual({
      method: 'GET',
      path: '/api/canvas/ws/screenshot?theme=dark',
    });
    expect(exportRequest('ws', { id: 'notes', name: 'n' }, 'json', 'dark')).toEqual({
      method: 'POST',
      path: '/api/canvas/ws/command',
      body: { tool: 'canvas_read', arguments: { root: 'notes' } },
    });
    expect(exportRequest('ws', { id: null, name: 'n' }, 'json', 'dark').body).toEqual({
      tool: 'canvas_read',
      arguments: {},
    });
  });

  it('builds a file name from the label that any system accepts', () => {
    const at = new Date(2026, 10, 13, 9, 5, 7);
    expect(exportFileName('Release notes / v2: "final"', 'png', at)).toBe('release-notes-v2-final-20261113-090507.png');
    expect(exportFileName('../../etc', 'json', at)).toBe('etc-20261113-090507.json');
    expect(exportFileName('日本語', 'json', at)).toBe('canvas-20261113-090507.json');
    expect(exportFileName('x'.repeat(200), 'png', at).length).toBeLessThanOrEqual(60 + 20);
  });
});
