import { targets, selectRegion } from './select.js';
import type { ViewObject } from './model.js';
import { nextFocus, siblings } from './tree.js';
import { pan, zoomAt, pinch, fit, type Point, type Rect, type Viewport } from './viewport.js';
export type RailView = 'keys' | 'reader' | 'thread' | 'history';
export type ViewState = {
  viewport: Viewport;
  focusId: string | null;
  selected: string[];
  tool: 'select' | 'pan';
  outlineOpen: boolean;
  rail: RailView[];
  letters: boolean;
  /** The open sub-canvas, or null for the whole workspace. A view setting: nothing is written. */
  root: string | null;
};
export type ViewCommand =
  | { kind: 'pan'; delta: Point }
  | { kind: 'zoom'; anchor: Point; factor: number }
  | { kind: 'pinch'; before: [Point, Point]; after: [Point, Point] }
  | { kind: 'fit'; bounds: Rect; area: Rect }
  | { kind: 'viewport'; viewport: Viewport }
  | { kind: 'focus'; id: string | null }
  | { kind: 'navigate'; step: number }
  | { kind: 'selection'; ids: string[] }
  | { kind: 'toggle'; id: string }
  | { kind: 'region'; region: Parameters<typeof selectRegion>[1]; parentId: string | null; toggle: boolean }
  | { kind: 'select-all' }
  | { kind: 'tool'; tool: ViewState['tool'] }
  | { kind: 'outline'; open: boolean }
  | { kind: 'rail'; view: RailView }
  | { kind: 'escape' }
  | { kind: 'letters'; enabled: boolean }
  | { kind: 'enter'; id: string }
  | { kind: 'leave' };
export const initialView = (): ViewState => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  focusId: null,
  selected: [],
  tool: 'select',
  outlineOpen: true,
  rail: [],
  letters: true,
  root: null,
});
export function command(state: ViewState, action: ViewCommand, objects: ViewObject[]): ViewState {
  switch (action.kind) {
    case 'pan':
      return { ...state, viewport: pan(state.viewport, action.delta) };
    case 'zoom':
      return { ...state, viewport: zoomAt(state.viewport, action.anchor, action.factor) };
    case 'pinch':
      return { ...state, viewport: pinch(state.viewport, action.before, action.after) };
    case 'fit':
      return { ...state, viewport: fit(action.bounds, action.area) };
    case 'viewport':
      return { ...state, viewport: action.viewport };
    case 'focus':
      return { ...state, focusId: action.id };
    case 'navigate':
      return { ...state, focusId: nextFocus(objects, state.focusId, action.step) };
    case 'selection':
      return { ...state, selected: targets(objects, action.ids).map((o) => o.id) };
    case 'toggle': {
      const ids = state.selected.includes(action.id)
        ? state.selected.filter((id) => id !== action.id)
        : [...state.selected, action.id];
      return { ...state, selected: targets(objects, ids).map((o) => o.id) };
    }
    case 'region': {
      const ids = selectRegion(objects, action.region, action.parentId);
      return {
        ...state,
        selected: targets(
          objects,
          action.toggle
            ? [...state.selected.filter((id) => !ids.includes(id)), ...ids.filter((id) => !state.selected.includes(id))]
            : ids
        ).map((o) => o.id),
      };
    }
    case 'select-all':
      return {
        ...state,
        selected: siblings(objects, objects.find((o) => o.id === state.focusId)?.parentId ?? null).map((o) => o.id),
      };
    case 'tool':
      return { ...state, tool: action.tool };
    case 'outline':
      return { ...state, outlineOpen: action.open };
    case 'rail':
      return { ...state, rail: [...state.rail.filter((v) => v !== action.view), action.view] };
    case 'escape':
      return { ...state, rail: state.rail.slice(0, -1) };
    case 'letters':
      return { ...state, letters: action.enabled };
    case 'enter': {
      const target = objects.find((o) => o.id === action.id);
      if (!target || target.type !== 'subcanvas') return state;
      return { ...state, root: target.id, selected: [], focusId: null };
    }
    case 'leave': {
      if (state.root === null) return state;
      const left = state.root;
      return { ...state, root: enclosingSubcanvas(objects, left), selected: [left], focusId: left };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** The nearest sub-canvas above an object, or null at the workspace level. */
export function enclosingSubcanvas(objects: ViewObject[], id: string): string | null {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const seen = new Set<string>();
  let current = byId.get(id)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) return null;
    if (parent.type === 'subcanvas') return parent.id;
    current = parent.parentId;
  }
  return null;
}
/** The nearest enclosing sub-canvas of every object, in one pass with memoised parents. */
export function subcanvasIndex(objects: ViewObject[]): Map<string, string | null> {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const memo = new Map<string, string | null>();
  const resolve = (id: string): string | null => {
    const chain: string[] = [];
    let found: string | null = null;
    let current = byId.get(id)?.parentId ?? null;
    let child = id;
    while (current !== null) {
      if (memo.has(child) && child !== id) {
        found = memo.get(child)!;
        break;
      }
      const parent = byId.get(current);
      if (!parent || chain.length > 512 || chain.includes(current)) break;
      if (parent.type === 'subcanvas') {
        found = parent.id;
        break;
      }
      chain.push(current);
      child = current;
      current = parent.parentId;
    }
    for (const between of chain) if (!memo.has(between)) memo.set(between, found);
    return found;
  };
  for (const o of objects) memo.set(o.id, resolve(o.id));
  return memo;
}
/** Sub-canvases from the workspace down to `root`, for the breadcrumb. */
export function viewPath(objects: ViewObject[], root: string | null): ViewObject[] {
  const path: ViewObject[] = [];
  const byId = new Map(objects.map((o) => [o.id, o]));
  for (let id = root; id !== null && path.length < 64; id = enclosingSubcanvas(objects, id)) {
    const o = byId.get(id);
    if (!o) break;
    path.unshift(o);
  }
  return path;
}
/** Objects drawn in a view rooted at `root` (its descendants, never the root itself); null means everything. */
export function viewMembers(objects: ViewObject[], root: string | null): Set<string> | null {
  if (root === null) return null;
  const children = new Map<string, string[]>();
  for (const o of objects) if (o.parentId) children.set(o.parentId, [...(children.get(o.parentId) ?? []), o.id]);
  const members = new Set<string>();
  const pending = [...(children.get(root) ?? [])];
  while (pending.length && members.size < 100_000) {
    const id = pending.pop()!;
    if (members.has(id) || id === root) continue;
    members.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return members;
}
